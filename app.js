// --- CONFIGURATION ---
const CLIENT_ID = '856541352892-kehe8kgckk0u18mni7909mhrcdp3jfl9.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.events.readonly';
const DISCOVERY_DOCS = [
    'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest',
    'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest'
];

let tokenClient;
let accessToken = null;
let gapiInited = false;
let gisInited = false;
let plannerFileId = null;
let calendarEventsList = []; 

// --- DOM ELEMENTS ---
const btnLogin = document.getElementById('btn-login');
const btnLogout = document.getElementById('btn-logout');
const btnSync = document.getElementById('btn-sync');
const syncStatus = document.getElementById('sync-status');

window.onload = function() {
    generateCalendarGrid();
    setupEventListeners();
    loadGoogleLibraries();
    injectCalendarVisibilityToggle();
    fetchWeatherForecast(); // Ahora sí llamará a la lógica restaurada
};

// --- LOADING LIBRARIES ---
function loadGoogleLibraries() {
    gapi.load('client', async () => {
        await gapi.client.init({ discoveryDocs: DISCOVERY_DOCS });
        gapiInited = true;
        checkEnginesReady();
    });
    initializeGisClient();
}

function initializeGisClient() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: async (tokenResponse) => {
            if (tokenResponse && tokenResponse.access_token) {
                accessToken = tokenResponse.access_token;
                gapi.auth.setToken(tokenResponse);
                
                // NEW: Save the session flag to local memory so the browser remembers the link
                localStorage.setItem('planner_session_active', 'true');
                
                updateAuthUI(true);
                syncStatus.textContent = 'Sincronizando nubes...';
                await checkOrCreatePlannerFile();
                await fetchGoogleCalendarEvents();
            }
        },
    });
    gisInited = true;
    checkEnginesReady();
}

function checkEnginesReady() {
    if (gapiInited && gisInited) {
        btnLogin.disabled = false;
        
        // NEW: Check if there is an active historical session flag
        const isSessionPersistent = localStorage.getItem('planner_session_active');
        
        if (isSessionPersistent === 'true' && tokenClient) {
            console.log("Persistent session detected. Initializing silent handshake with Google API...");
            syncStatus.textContent = 'Autoconectando...';
            // prompt: 'none' requests the token silently without popping up any UI windows
            tokenClient.requestAccessToken({ prompt: 'none' });
        }
    }
}

// --- DYNAMIC GEOLOCATION & WEATHER ENGINE ---
async function fetchWeatherForecast() {
    // Coordenadas por defecto (Bogotá) en caso de que se niegue el GPS
    let lat = 4.6097;
    let lon = -74.0817;

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            async (position) => {
                lat = position.coords.latitude;
                lon = position.coords.longitude;
                console.log(`Ubicación GPS detectada: Lat ${lat.toFixed(4)}, Lon ${lon.toFixed(4)}`);
                await callWeatherAPI(lat, lon);
            },
            async (error) => {
                console.warn("Acceso a la ubicación denegado. Usando Bogotá por defecto.");
                await callWeatherAPI(lat, lon);
            },
            { timeout: 5000 }
        );
    } else {
        console.warn("El navegador no sopcura Geolocalización. Usando Bogotá por defecto.");
        await callWeatherAPI(lat, lon);
    }
}

async function callWeatherAPI(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation_probability,cloud_cover&forecast_days=2&timezone=auto`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data && data.hourly) {
            processWeatherData(data.hourly);
        }
    } catch (err) {
        console.error("Error al conectar con la API de Open-Meteo:", err);
    }
}

function processWeatherData(hourlyData) {
    const getDayMetrics = (dayIndex) => {
        const startIdx = dayIndex * 24;
        const endIdx = startIdx + 24;
        
        const rainProbs = hourlyData.precipitation_probability.slice(startIdx, endIdx);
        const clouds = hourlyData.cloud_cover.slice(startIdx, endIdx);
        
        // Encontrar la probabilidad máxima de lluvia
        const maxRainProb = Math.max(...rainProbs);
        
        // Encontrar la hora exacta en la que ocurre ese pico máximo
        const relativePeakHour = rainProbs.indexOf(maxRainProb);
        const peakHourString = `${String(relativePeakHour).padStart(2, '0')}:00`;
        
        // Calcular el promedio de nubosidad para estados alternos
        const avgCloud = clouds.reduce((a, b) => a + b, 0) / 24;
        
        return { maxRainProb, peakHourString, avgCloud };
    };

    renderWeatherRibbon('day-1', getDayMetrics(0)); // Hoy
    renderWeatherRibbon('day-2', getDayMetrics(1)); // Mañana
}

function renderWeatherRibbon(cardId, metrics) {
    const card = document.getElementById(cardId);
    if (!card) return;
    
    const parentCard = card.closest('.day-card');
    let ribbon = parentCard.querySelector('.weather-ribbon');
    if (!ribbon) {
        ribbon = document.createElement('div');
        ribbon.className = 'weather-ribbon';
        parentCard.appendChild(ribbon);
    }

    let icon = '☀️';
    let displayLabel = '';

    // Regla 1: Si hay cualquier pico de probabilidad de lluvia mayor al 50%
    if (metrics.maxRainProb > 50) {
        icon = '☔';
        displayLabel = `${metrics.peakHourString} (${metrics.maxRainProb}%)`; // Muestra la hora del pico al frente
    } 
    // Regla 2: Riesgo bajo de lluvia pero nubosidad promedio alta (>50%)
    else if (metrics.avgCloud > 50) {
        icon = '⛅'; // Medio sol, medio nublado
        displayLabel = `${metrics.maxRainProb}%`; // Omite la hora
    } 
    // Regla 3: Cielo completamente despejado o baja nubosidad
    else {
        icon = '☀️'; // Sol brillante
        displayLabel = `${metrics.maxRainProb}%`; // Omite la hora
    }

    ribbon.innerHTML = `<span class="weather-icon">${icon}</span> <span style="margin-left: 4px;">${displayLabel}</span>`;
}

// --- GOOGLE CALENDAR ENGINE ---
async function fetchGoogleCalendarEvents() {
    try {
        const timeMin = new Date().toISOString();
        const timeMax = new Date();
        timeMax.setDate(timeMax.getDate() + 14);

        const response = await gapi.client.calendar.events.list({
            calendarId: 'primary',
            timeMin: timeMin,
            timeMax: timeMax.toISOString(),
            singleEvents: true,
            orderBy: 'startTime'
        });

        calendarEventsList = response.result.items || [];
        distributeEventsToGrid();
    } catch (err) {
        console.error("Error reading Google Calendar event matrix arrays:", err);
    }
}

function distributeEventsToGrid() {
    document.querySelectorAll('.calendar-events-container').forEach(el => el.innerHTML = '');

    const baseDate = new Date();
    baseDate.setHours(0, 0, 0, 0);

    calendarEventsList.forEach(event => {
        const eventDateStr = event.start.dateTime || event.start.date;
        const eventDate = new Date(eventDateStr);
        eventDate.setHours(0, 0, 0, 0);

        const diffTime = Math.abs(eventDate - baseDate);
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24)) + 1;

        if (diffDays >= 1 && diffDays <= 14) {
            const container = document.getElementById(`cal-container-${diffDays}`);
            if (container) {
                const eventItem = document.createElement('div');
                eventItem.className = 'calendar-event-item';
                eventItem.title = event.summary;
                eventItem.textContent = event.summary;
                container.appendChild(eventItem);
            }
        }
    });
}

function injectCalendarVisibilityToggle() {
    const header = document.querySelector('header');
    const controls = document.createElement('div');
    controls.className = 'calendar-controls';
    controls.innerHTML = `
        <input type="checkbox" id="toggle-calendar" checked>
        <label for="toggle-calendar">Mostrar Eventos de Google Calendar</label>
    `;
    header.parentNode.insertBefore(controls, header.nextSibling);

    document.getElementById('toggle-calendar').addEventListener('change', (e) => {
        const main = document.querySelector('main');
        if (e.target.checked) {
            main.classList.remove('hidden-calendar');
        } else {
            main.classList.add('hidden-calendar');
        }
    });
}

// --- GOOGLE DRIVE STORAGE LOGIC ---
async function checkOrCreatePlannerFile() {
    try {
        const response = await gapi.client.drive.files.list({
            q: "name = 'weekplan_data.json' and trashed = false",
            fields: 'files(id)'
        });
        const files = response.result.files;
        if (files && files.length > 0) {
            plannerFileId = files[0].id;
            await loadPlannerData();
        } else {
            await createNewPlannerFile();
        }
    } catch (err) {
        console.error("Drive system handshake exception:", err);
        syncStatus.textContent = 'Error';
    }
}

async function loadPlannerData() {
    try {
        const response = await gapi.client.drive.files.get({ fileId: plannerFileId, alt: 'media' });
        const data = response.result;
        if (data) {
            for (let i = 1; i <= 14; i++) {
                if (data[`day-${i}`] !== undefined) {
                    document.getElementById(`day-${i}`).value = data[`day-${i}`];
                }
            }
            syncStatus.textContent = 'Sincronizado';
        }
    } catch (err) {
        console.error("Storage load malfunction:", err);
    }
}

async function savePlannerToDrive() {
    if (!plannerFileId) return;
    syncStatus.textContent = 'Guardando...';
    const plannerData = {};
    for (let i = 1; i <= 14; i++) {
        plannerData[`day-${i}`] = document.getElementById(`day-${i}`).value;
    }
    try {
        const fileContent = JSON.stringify(plannerData);
        const blob = new Blob([fileContent], { type: 'application/json' });
        const metadata = { name: 'weekplan_data.json', mimeType: 'application/json' };
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', blob);

        const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${plannerFileId}?uploadType=multipart`, {
            method: 'PATCH',
            headers: new Headers({ 'Authorization': 'Bearer ' + accessToken }),
            body: form
        });
        if (res.ok) syncStatus.textContent = 'Cambios Guardados';
    } catch (err) {
        console.error("Storage sync patch error:", err);
    }
}

async function createNewPlannerFile() {
    try {
        const response = await gapi.client.drive.files.create({
            resource: { name: 'weekplan_data.json', mimeType: 'application/json' }, fields: 'id'
        });
        plannerFileId = response.result.id;
        await savePlannerToDrive();
    } catch (err) {
        console.error("Error writing file template blueprint:", err);
    }
}

function setupEventListeners() {
    btnLogin.addEventListener('click', () => tokenClient && tokenClient.requestAccessToken({ prompt: '' }));
    
    btnLogout.addEventListener('click', () => {
        accessToken = null;
        plannerFileId = null;
        
        // NEW: Completely erase the session flag from browser local storage
        localStorage.removeItem('planner_session_active');
        
        updateAuthUI(false);
        for (let i = 1; i <= 14; i++) document.getElementById(`day-${i}`).value = "";
        document.querySelectorAll('.calendar-events-container').forEach(el => el.innerHTML = '');
    });
    
    btnSync.addEventListener('click', savePlannerToDrive);
}

function updateAuthUI(isLoggedIn) {
    if (isLoggedIn) {
        btnLogin.classList.add('hidden');
        btnLogout.classList.remove('hidden');
        btnSync.classList.remove('hidden');
    } else {
        btnLogin.classList.remove('hidden');
        btnLogout.classList.add('hidden');
        btnSync.classList.add('hidden');
        syncStatus.textContent = 'Desconectado';
    }
}

function generateCalendarGrid() {
    const week1Grid = document.getElementById('grid-week-1');
    const week2Grid = document.getElementById('grid-week-2');
    const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

    week1Grid.innerHTML = ''; 
    week2Grid.innerHTML = '';

    const baseDate = new Date();

    for (let i = 0; i < 7; i++) {
        const targetDate = new Date(baseDate);
        targetDate.setDate(baseDate.getDate() + i);

        const dayName = dayNames[targetDate.getDay()]; 
        const dayOfMonth = targetDate.getDate();       
        const uniqueDayIndex = i + 1;                  

        week1Grid.appendChild(createDayCard(dayName, dayOfMonth, uniqueDayIndex));
    }

    for (let i = 7; i < 14; i++) {
        const targetDate = new Date(baseDate);
        targetDate.setDate(baseDate.getDate() + i);

        const dayName = dayNames[targetDate.getDay()];
        const dayOfMonth = targetDate.getDate();
        const uniqueDayIndex = i + 1;

        week2Grid.appendChild(createDayCard(dayName, dayOfMonth, uniqueDayIndex));
    }
}

function createDayCard(dayName, dayOfMonth, uniqueDayIndex) {
    const card = document.createElement('div');
    card.className = 'day-card';
    card.innerHTML = `
        <strong>${dayName} ${dayOfMonth}</strong>
        <textarea id="day-${uniqueDayIndex}" rows="3" placeholder="Planes o tareas..."></textarea>
        <div class="calendar-events-container" id="cal-container-${uniqueDayIndex}"></div>
    `;
    return card;
}