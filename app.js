// Configuration
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OSRM_TRIP_URL = 'https://router.project-osrm.org/trip/v1/driving/';
const OSRM_ROUTE_URL = 'https://router.project-osrm.org/route/v1/driving/';

let map;
let markers = [];
let routeLine;
let addresses = []; // { text, coords }
let stagedAddresses = []; // [{ mahalle, sokak, no, detay, ilce }]
let optimizedWaypoints = []; // Stores coords in optimized order

const ISTANBUL_DISTRICTS = [
    'Adalar', 'Arnavutköy', 'Ataşehir', 'Avcılar', 'Bağcılar', 'Bahçelievler', 'Bakırköy', 'Başakşehir',
    'Bayrampaşa', 'Beşiktaş', 'Beykoz', 'Beylikdüzü', 'Beyoğlu', 'Büyükçekmece', 'Çatalca', 'Çekmeköy',
    'Esenler', 'Esenyurt', 'Eyüpsultan', 'Fatih', 'Gaziosmanpaşa', 'Güngören', 'Kadıköy', 'Kağıthane',
    'Kartal', 'Küçükçekmece', 'Maltepe', 'Pendik', 'Sancaktepe', 'Sarıyer', 'Şile', 'Silivri',
    'Şişli', 'Sultanbeyli', 'Sultangazi', 'Tuzla', 'Ümraniye', 'Üsküdar', 'Zeytinburnu'
];

// Initialize Map
function initMap() {
    // İstanbul Avrupa Yakası Sınırları (Yaklaşık)
    const europeanSideBounds = L.latLngBounds(
        [40.80, 28.10], // Güney-Batı (Silivri açıkları)
        [41.50, 29.10]  // Kuzey-Doğu (Karadeniz / Boğaz hattı)
    );

    map = L.map('map', {
        maxBounds: europeanSideBounds,
        maxBoundsViscosity: 1.0,
        minZoom: 10
    }).setView([41.05, 28.85], 11); // Avrupa Yakası merkezi odaklı

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    // Try to get user location
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(position => {
            const { latitude, longitude } = position.coords;
            // Sadece sınırların içindeyse odaklan
            if (europeanSideBounds.contains([latitude, longitude])) {
                map.setView([latitude, longitude], 13);
                L.marker([latitude, longitude]).addTo(map).bindPopup('Sizin Konumunuz (Başlangıç)').openPopup();
                addresses.push({ text: 'Mevcut Konum', coords: [latitude, longitude], isStart: true });
                renderAddressList();
            } else {
                console.log("Konum Avrupa yakası dışında olduğu için es geçildi.");
            }
        });
    }
}

// OCR Logic
async function processImage(file) {
    showStatus(`Görsel işleniyor: ${file.name}...`);
    try {
        const result = await Tesseract.recognize(file, 'tur', {
            logger: m => console.log(m)
        });
        const fullText = result.data.text;
        
        // "İSTANBUL" kelimesini ayraç olarak kullanarak metni parçala
        const segments = fullText.split(/(?:İSTANBUL|ISTANBUL)/gi);
        
        stagedAddresses = [];
        for (let segment of segments) {
            const cleaned = cleanAddressText(segment);
            if (cleaned.length > 10) { 
                stagedAddresses.push(parseAddress(cleaned));
            }
        }

        if (stagedAddresses.length > 0) {
            renderStagingList();
        } else {
            alert("Görselde anlaşılır bir adres bulunamadı.");
        }
    } catch (error) {
        console.error("OCR Error:", error);
        alert("Görsel işlenirken hata oluştu.");
    }
    hideStatus();
}

function renderStagingList() {
    const list = document.getElementById('staging-list');
    const panel = document.getElementById('staging-panel');
    list.innerHTML = '';
    panel.style.display = 'block';

    stagedAddresses.forEach((addr, index) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'staged-item-structured';
        wrapper.innerHTML = `
            <div class="field-grid">
                <div class="field">
                    <label>Mahalle</label>
                    <input type="text" value="${addr.mahalle}" onchange="updateStagedField(${index}, 'mahalle', this.value)" placeholder="Örn: Merkez Mah.">
                </div>
                <div class="field">
                    <label>Sokak/Cadde</label>
                    <input type="text" value="${addr.sokak}" onchange="updateStagedField(${index}, 'sokak', this.value)" placeholder="Örn: Darülaceze Cd.">
                </div>
                <div class="field">
                    <label>No</label>
                    <input type="text" value="${addr.no}" onchange="updateStagedField(${index}, 'no', this.value)" placeholder="Örn: 8">
                </div>
                <div class="field">
                    <label>İlçe</label>
                    <input type="text" value="${addr.ilce}" onchange="updateStagedField(${index}, 'ilce', this.value)" placeholder="Örn: Şişli">
                </div>
                <div class="field full">
                    <label>Bina/Kat/Daire</label>
                    <input type="text" value="${addr.detay}" onchange="updateStagedField(${index}, 'detay', this.value)" placeholder="Örn: Kat 6 Daire 12">
                </div>
                <div class="field full">
                    <label>Not / Talimat 📝</label>
                    <input type="text" value="${addr.not || ''}" onchange="updateStagedField(${index}, 'not', this.value)" placeholder="Örn: Zil bozuk, kapıya bırakın">
                </div>
            </div>
            <span class="remove-btn" onclick="removeStaged(${index})">🗑️</span>
        `;
        list.appendChild(wrapper);
    });
}

function parseAddress(text) {
    const addressObj = {
        mahalle: '',
        sokak: '',
        no: '',
        detay: '',
        ilce: '',
        not: '',
        sehir: 'İstanbul'
    };

    // İlçe Bulma
    for (const district of ISTANBUL_DISTRICTS) {
        if (text.toLowerCase().includes(district.toLowerCase())) {
            addressObj.ilce = district;
            break;
        }
    }

    // Mahalle (örn: Merkez mah. / Atatürk mahallesi)
    const mahMatch = text.match(/([^,.\n]+)\s+(?:mah\.|mahallesi)/i);
    if (mahMatch) addressObj.mahalle = mahMatch[1].trim() + " Mah.";

    // Sokak/Cadde (örn: Bağlar cad. / Gül sok.)
    const sokMatch = text.match(/([^,.\n]+)\s+(?:cd\.|cad\.|cadde|sk\.|sok\.|sokak|bulvarı|blv\.)/i);
    if (sokMatch) addressObj.sokak = sokMatch[1].trim() + " " + sokMatch[0].split(' ').pop();

    // No (örn: No: 45 / No 45)
    const noMatch = text.match(/No\s*[:\s]?\s*(\d+[\/\d]*)/i);
    if (noMatch) addressObj.no = noMatch[1];

    // Kat/Daire (örn: Kat 6 / Daire 12 / giris kat)
    const detayMatch = text.match(/(?:Kat|Daire|giris|giriş)\s*[:\s]?\s*(\d+|kat)/i);
    if (detayMatch) addressObj.detay = detayMatch[0].trim();

    return addressObj;
}

function updateStagedField(index, field, value) {
    stagedAddresses[index][field] = value;
}

function removeStaged(index) {
    stagedAddresses.splice(index, 1);
    renderStagingList();
}

let currentNote = ""; // Temporary storage for geocoding process

async function markStagedOnMap() {
    if (stagedAddresses.length === 0) return;
    
    showStatus("Adresler haritaya aktarılıyor...");
    const toProcess = [...stagedAddresses];
    stagedAddresses = [];
    document.getElementById('staging-panel').style.display = 'none';

    for (let addr of toProcess) {
        currentNote = addr.not;
        // Yapılandırılmış veriden arama sorgusu oluştur
        const query = `${addr.mahalle} ${addr.sokak} No:${addr.no} ${addr.ilce} ${addr.sehir}`;
        await geocodeAndAdd(query);
    }
    currentNote = "";
    hideStatus();
}

function cleanAddressText(text) {
    return text
        .replace(/\d{1,2}[:.]\d{2}/g, '') // Saatleri temizle (20:12 vb.)
        .replace(/(?:Teslim alındı|Teslim edildi|Güzargah Listesi|Bugün|Dün|Mevcut Konum|Barkod|Ürün No)/gi, '') // Durum yazılarını temizle
        .replace(/#\s*[A-Z0-9-]+/gi, '') // # C7, # 38-52 gibi kodları temizle
        .replace(/^[^\wçğıöşüÇĞİÖŞÜ]+/gm, '') // Her satırın başındaki sembolleri temizle (m flag ile her satıra bak)
        .replace(/(?:Kat\s*\d+|Daire\s*\d+|giriş kat|giris kat|kat:\d+)/gi, '') // Kat/Daire bilgisini temizle
        .replace(/[:>|—_]/g, '') // Ayraç ve sembolleri temizle
        .replace(/[ \t]+/g, ' ') // Yan yana boşlukları temizle (satır sonlarını koru)
        .trim();
}

// Geocoding Logic
async function geocodeAndAdd(text, isRetry = false) {
    const query = encodeURIComponent(text.substring(0, 100));
    const bbox = "28.1,41.5,29.1,40.8"; 
    
    try {
        const response = await fetch(`${NOMINATIM_URL}?format=json&q=${query}&viewbox=${bbox}&bounded=1&limit=1`);
        const data = await response.json();
        
        if (data && data.length > 0) {
            const { lat, lon, display_name } = data[0];
            const coords = [parseFloat(lat), parseFloat(lon)];
            addresses.push({ text: display_name, coords });
            renderAddressList();
            addMarker(coords, display_name);
        } else if (!isRetry) {
            // İlk deneme başarısızsa, daha basit bir arama dene (Örn: No: varsa sil)
            const fallbackText = text.replace(/No\s*:\s*\d+/gi, '').trim();
            if (fallbackText !== text) {
                console.log("Yeniden deneniyor (basitleştirilmiş):", fallbackText);
                await geocodeAndAdd(fallbackText, true);
            } else {
                failGeocoding(text);
            }
        } else {
            failGeocoding(text);
        }
    } catch (error) {
        console.error("Geocoding error:", error);
        if (!isRetry) failGeocoding(text);
    }
}

function failGeocoding(text) {
    addresses.push({ text: "Haritada bulunamadı: " + text.substring(0, 50), coords: null, raw: text });
    renderAddressList();
}

function renderAddressList() {
    const list = document.getElementById('address-list');
    const container = document.getElementById('address-container');
    list.innerHTML = '';
    
    if (addresses.length > 0) container.style.display = 'block';

    addresses.forEach((addr, index) => {
        const item = document.createElement('li');
        item.className = 'address-item' + (addr.coords ? '' : ' error') + (addr.isDelivered ? ' delivered' : '');
        const display = addr.text.length > 40 ? addr.text.substring(0, 40) + '...' : addr.text;
        
        item.innerHTML = `
            <div class="addr-text">
                <span class="main-addr">${index + 1}. ${display}</span>
                ${addr.note ? `<span class="addr-note">📝 ${addr.note}</span>` : ''}
                <div class="addr-actions">
                    ${!addr.coords ? `<button class="edit-btn" onclick="editAddress(${index})">Düzenle ✏️</button>` : '✅'}
                    ${addr.coords ? `
                        <button class="status-btn" onclick="toggleDelivery(${index})">${addr.isDelivered ? 'Geri Al ↩️' : 'Teslim Et ✅'}</button>
                        <button class="whatsapp-btn" onclick="shareOnWhatsApp(${index})">WhatsApp 💬</button>
                    ` : ''}
                </div>
            </div>
            <span class="remove-btn" onclick="removeAddress(${index})">🗑️</span>
        `;
        list.appendChild(item);
    });
}

function toggleDelivery(index) {
    addresses[index].isDelivered = !addresses[index].isDelivered;
    renderAddressList();
    // Update marker color if optimized
    if (optimizedWaypoints.length > 0) {
        reRenderOptimizedMarkers();
    } else {
        updateMapMarkers();
    }
}

function editAddress(index) {
    const newText = prompt("Adresi düzenle:", addresses[index].raw || addresses[index].text);
    if (newText) {
        addresses.splice(index, 1);
        geocodeAndAdd(newText);
    }
}

function removeAddress(index) {
    addresses.splice(index, 1);
    renderAddressList();
    updateMapMarkers();
}

function updateMapMarkers() {
    markers.forEach(m => map.removeLayer(m));
    markers = [];
    addresses.forEach((addr, index) => {
        if (addr.coords) {
            addMarker(addr.coords, addr.text);
        }
    });
}

function addMarker(coords, text, number = null) {
    let icon;
    if (number) {
        icon = L.divIcon({
            className: 'custom-div-icon',
            html: `<div class='marker-pin'><span>${number}</span></div>`,
            iconSize: [30, 42],
            iconAnchor: [15, 42]
        });
    }

    const marker = L.marker(coords, { icon: icon }).addTo(map).bindPopup(text);
    markers.push(marker);
}

// Rota Optimizasyonu (TSP)
async function optimizeRoute() {
    const validPoints = addresses.filter(a => a.coords);
    if (validPoints.length < 2) {
        alert("En az 2 geçerli adres gereklidir.");
        return;
    }

    showStatus("Rota hesaplanıyor...");
    
    // OSRM Trip API requires coords in lon,lat format separated by semicolon
    const coordsString = validPoints.map(p => `${p.coords[1]},${p.coords[0]}`).join(';');
    
    try {
        const response = await fetch(`${OSRM_TRIP_URL}${coordsString}?source=first&destination=any&roundtrip=false&geometries=geojson`);
        const data = await response.json();

        if (data.code === 'Ok') {
            // OSRM Trip API optimized order
            optimizedWaypoints = data.waypoints
                .sort((a, b) => a.waypoint_index - b.waypoint_index)
                .map(w => w.location);

            displayRoute(data.trips[0]);
            updateRouteStats(data.trips[0]);
            
            reRenderOptimizedMarkers();
        } else {
            alert("Rota hesaplanamadı: " + data.code);
        }
    } catch (error) {
        console.error("Routing error:", error);
        alert("Navigasyon servisine bağlanılamadı.");
    }
    hideStatus();
}

function displayRoute(trip) {
    if (routeLine) map.removeLayer(routeLine);
    
    routeLine = L.geoJSON(trip.geometry, {
        style: { color: '#4f46e5', weight: 5, opacity: 0.8 }
    }).addTo(map);
    
    map.fitBounds(routeLine.getBounds(), { padding: [50, 50] });
    document.getElementById('route-info').style.display = 'flex';
}

function updateRouteStats(trip) {
    const distance = (trip.distance / 1000).toFixed(1) + ' km';
    const duration = Math.round(trip.duration / 60) + ' dk';
    document.getElementById('total-distance').innerText = distance;
    document.getElementById('total-time').innerText = duration;
}

function startNavigation() {
    if (optimizedWaypoints.length < 2) return;

    // Google Maps URL with waypoints
    // Format: https://www.google.com/maps/dir/lat1,lon1/lat2,lon2/.../latN,lonN/
    const baseUrl = "https://www.google.com/maps/dir/";
    const pointsUrl = optimizedWaypoints
        .map(coord => `${coord[1]},${coord[0]}`) // [lat, lon]
        .join('/');
    
    const finalUrl = baseUrl + pointsUrl + "/";
    window.open(finalUrl, '_blank');
}

function addTestAddresses() {
    const testList = [
        ["İstiklal Caddesi, Beyoğlu", "Kapıda ödeme var"], ["Halaskargazi Cd., Şişli", "Zil bozuk"], ["İmrahor Cd., Kağıthane", ""],
        ["Abdi İpekçi Cd., Beşiktaş", "Güvenliğe bırakın"], ["Büyükdere Cd., Levent", ""], ["Bağdat Cd., Bakırköy", ""],
        ["Kennedy Cd., Fatih", "Giriş kat"], ["Turgut Özal Bulvarı, Başakşehir", ""], ["Atatürk Cd., Esenyurt", ""],
        ["Cumhuriyet Cd., Sarıyer", ""], ["Millet Cd., Fatih", ""], ["Vatan Cd., Fatih", ""],
        ["Eski Büyükdere Cd., Kağıthane", ""], ["İnönü Cd., Beyoğlu", ""], ["Dolmabahçe Cd., Beşiktaş", ""],
        ["Çırağan Cd., Beşiktaş", ""], ["Muallim Naci Cd., Ortaköy", ""], ["Koru Cd., İstinye", ""],
        ["Dereboyu Cd., Mecidiyeköy", ""], ["Gülbahar Cd., Şişli", ""]
    ];

    stagedAddresses = testList.map(item => {
        const addr = parseAddress(item[0]);
        addr.not = item[1];
        return addr;
    });
    renderStagingList();
    showStatus("20 adet test adresi ve talimatlar yüklendi.");
    setTimeout(hideStatus, 2000);
}

function shareOnWhatsApp(index) {
    const addr = addresses[index];
    let msg = `Merhaba, Kargonuz yolda! 📦\n\n📍 Adres: ${addr.text}`;
    if (addr.note) msg += `\n📝 Not: ${addr.note}`;
    msg += `\n\nYaklaşık 10-15 dakika içinde kapınızdayım.`;
    
    const url = `https://wa.me/?text=${encodeURIComponent(msg)}`;
    window.open(url, '_blank');
}

// UI Helpers
function showStatus(text) {
    const panel = document.getElementById('status-panel');
    panel.style.display = 'block';
    document.getElementById('status-text').innerText = text;
}

function hideStatus() {
    document.getElementById('status-panel').style.display = 'none';
}

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    initMap();

    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const optimizeBtn = document.getElementById('optimize-btn');
    const markOnMapBtn = document.getElementById('mark-on-map-btn');
    const startNavBtn = document.getElementById('start-nav-btn');
    const testBtn = document.getElementById('add-test-data-btn');

    dropZone.onclick = () => fileInput.click();
    
    fileInput.onchange = (e) => {
        const files = Array.from(e.target.files);
        files.forEach(processImage);
    };

    dropZone.ondragover = (e) => {
        e.preventDefault();
        dropZone.style.borderColor = 'var(--primary)';
    };

    dropZone.ondrop = (e) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files);
        files.forEach(processImage);
    };

    optimizeBtn.onclick = optimizeRoute;
    markOnMapBtn.onclick = markStagedOnMap;
    startNavBtn.onclick = startNavigation;
    testBtn.onclick = addTestAddresses;
});
