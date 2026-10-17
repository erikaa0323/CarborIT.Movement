
/* CarbonIt | Green Map Iași — GTFS + Valhalla */

document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  const $ = id => document.getElementById(id);
  const status = $('status');

  if (!status || !$('map') || typeof L === 'undefined') {
    return;
  }

  const setStatus = message => {
    status.textContent = message;
  };

  const IASI = [47.1585, 27.6014];

  const map = L.map('map', {
    center: IASI,
    zoom: 13,
    preferCanvas: true,
    zoomAnimation: false,
    fadeAnimation: false
  });

  L.tileLayer(
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
      updateWhenIdle: true,
      keepBuffer: 2
    }
  )
    .on('tileerror', () => {
      console.warn('Unele imagini OSM nu au fost încărcate.');
    })
    .addTo(map);

  const points = L.layerGroup().addTo(map);
  const lines = L.layerGroup().addTo(map);

  let start = null;
  let end = null;
  let busy = false;
  let gtfs = null;

  const FACTORS = {
    pedestrian: 0,
    bicycle: 0,
    auto: 0.15,
    bus: 0.08,
    tram: 0.035
  };

  const fmtTime = m => {
    const total = Math.round(m);
    return (
      String(Math.floor(total / 60) % 24).padStart(2, '0') +
      ':' +
      String(total % 60).padStart(2, '0')
    );
  };

  const fmtDuration = m =>
    `${Math.max(1, Math.round(m))} min`;

  const dist = (a, b) => map.distance(a, b);

  const stopLatLng = id => {
    const s = gtfs.stops[id];
    return s ? [s[1], s[2]] : null;
  };

  function resetResults() {
    lines.clearLayers();

    $('distance').textContent = '—';
    $('duration').textContent = '—';
    $('co2').textContent = '—';

    if ($('routeInfo')) {
      $('routeInfo').hidden = true;
    }

    if ($('instructions')) {
      $('instructions').replaceChildren();
    }
  }

  function reset() {
    if (busy) return;

    start = null;
    end = null;

    points.clearLayers();
    resetResults();

    setStatus('Selectează plecarea pe hartă.');
  }

  function marker(latlng, color, text) {
    L.circleMarker(latlng, {
      radius: 9,
      color: '#ffffff',
      weight: 3,
      fillColor: color,
      fillOpacity: 1
    })
      .bindPopup(text)
      .addTo(points);
  }

  map.on('click', e => {
    if (busy) return;

    if (start && end) {
      reset();
    }

    if (!start) {
      start = e.latlng;

      marker(start, '#20c997', 'Plecare');

      setStatus('Selectează destinația.');
    } else {
      end = e.latlng;

      marker(end, '#eb5757', 'Destinație');

      setStatus('Apasă „Calculează ruta”.');
    }
  });

  function instructions(items) {
    const list = $('instructions');

    if (!list) return;

    list.replaceChildren();

    for (const message of items) {
      const li = document.createElement('li');
      li.textContent = message;
      list.appendChild(li);
    }
  }

  function result(
    distanceKm,
    minutes,
    emissionsKg,
    title,
    description
  ) {
    $('distance').textContent =
      distanceKm.toFixed(2) + ' km';

    $('duration').textContent =
      fmtDuration(minutes);

    $('co2').textContent =
      emissionsKg.toFixed(3) + ' kg';

    if ($('co2Label')) {
      $('co2Label').textContent = 'CO₂ estimat';
    }

    if ($('routeInfo')) {
      $('routeInfo').hidden = false;
    }

    if ($('routeTitle')) {
      $('routeTitle').textContent = title;
    }

    if ($('routeDescription')) {
      $('routeDescription').textContent = description;
    }
  }

  // Decodifică geometria Valhalla
  function polyline6(encoded) {
    let i = 0;
    let lat = 0;
    let lon = 0;

    const coords = [];

    while (i < encoded.length) {
      const values = [];

      for (let j = 0; j < 2; j++) {
        let shift = 0;
        let n = 0;
        let b;

        do {
          if (i >= encoded.length) {
            throw Error('Geometrie incompletă.');
          }

          b = encoded.charCodeAt(i++) - 63;
          n |= (b & 31) << shift;
          shift += 5;
        } while (b >= 32);

        values.push(
          n & 1 ? ~(n >> 1) : n >> 1
        );
      }

      lat += values[0];
      lon += values[1];

      coords.push([lat / 1e6, lon / 1e6]);
    }

    return coords;
  }

  // Rutare pentru mers, bicicletă și mașină
  async function roadRoute(mode, priority) {
    const costing_options =
      mode === 'auto'
        ? {
            auto: {
              shortest: priority === 'green'
            }
          }
        : mode === 'bicycle'
          ? {
              bicycle: {
                bicycle_type: 'hybrid',
                use_roads:
                  priority === 'green' ? 0.2 : 0.6
              }
            }
          : {
              pedestrian: {
                use_hills:
                  priority === 'green' ? 0.3 : 0.5
              }
            };

    const payload = {
      locations: [
        {
          lat: start.lat,
          lon: start.lng
        },
        {
          lat: end.lat,
          lon: end.lng
        }
      ],
      costing: mode,
      costing_options,
      units: 'kilometers',
      shape_format: 'polyline6',
      language: 'ro-RO'
    };

    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      20000
    );

    try {
      const url =
        'https://valhalla1.openstreetmap.de/route?json=' +
        encodeURIComponent(JSON.stringify(payload));

      const response = await fetch(url, {
        signal: controller.signal
      });

      if (!response.ok) {
        throw Error(
          'Serviciul de rutare nu răspunde (' +
          response.status +
          ').'
        );
      }

      const data = await response.json();

      if (!data.trip?.legs?.length) {
        throw Error(
          'Nu există rută pentru aceste puncte.'
        );
      }

      const coords = [];
      const steps = [];

      for (const [i, leg] of data.trip.legs.entries()) {
        const part = polyline6(leg.shape);

        if (i) {
          part.shift();
        }

        coords.push(...part);

        for (const maneuver of leg.maneuvers || []) {
          steps.push(
            maneuver.instruction ||
            'Continuă pe traseu.'
          );
        }
      }

      if (coords.length < 2) {
        throw Error('Ruta nu conține geometrie.');
      }

      const line = L.polyline(coords, {
        color:
          priority === 'green'
            ? '#20b56d'
            : '#3898ed',
        weight: 6
      }).addTo(lines);

      map.fitBounds(line.getBounds(), {
        padding: [30, 30],
        maxZoom: 16
      });

      const km = data.trip.summary.length;

      result(
        km,
        data.trip.summary.time / 60,
        km * FACTORS[mode],
        priority === 'green'
          ? 'Rută verde'
          : 'Rută utilizată',
        mode === 'auto' && priority === 'green'
          ? 'Preferință pentru distanță mai scurtă; nu garantează consumul minim.'
          : 'Traseu calculat pe rețeaua rutieră.'
      );

      instructions(
        steps.length
          ? steps
          : ['Urmărește traseul afișat.']
      );

      setStatus('Ruta a fost calculată.');
    } finally {
      clearTimeout(timeout);
    }
  }

  // Încărcarea datelor CTP Iași
  async function loadGTFS() {
    if (gtfs) return;

    setStatus(
      'Se încarcă orarele CTP Iași (aproximativ 4 MB)...'
    );

    const response = await fetch('./data/ctpi.json');

    if (!response.ok) {
      throw Error(
        'Nu găsesc data/ctpi.json (HTTP ' +
        response.status +
        ').'
      );
    }

    gtfs = await response.json();

    if (
      !gtfs.trips ||
      !gtfs.stops ||
      !gtfs.calendar ||
      !gtfs.routes
    ) {
      throw Error(
        'Formatul fișierului ctpi.json este invalid.'
      );
    }
  }

  // Data și ora curentă din Iași
  function iasiNow() {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Bucharest',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        weekday: 'short'
      })
        .formatToParts(new Date())
        .filter(x => x.type !== 'literal')
        .map(x => [x.type, x.value])
    );

    const days = {
      Mon: 0,
      Tue: 1,
      Wed: 2,
      Thu: 3,
      Fri: 4,
      Sat: 5,
      Sun: 6
    };

    return {
      date:
        parts.year +
        parts.month +
        parts.day,
      day: days[parts.weekday],
      minute:
        Number(parts.hour) * 60 +
        Number(parts.minute)
    };
  }

  // Verifică valabilitatea unui serviciu
  function active(calendar, now) {
    return (
      calendar &&
      calendar[now.day] &&
      now.date >= calendar[7] &&
      now.date <= calendar[8]
    );
  }

  // Găsește stații apropiate de un punct
  function nearby(point, radius = 950, limit = 10) {
    const matches = [];

    for (const [id, stop] of Object.entries(gtfs.stops)) {
      const distance = dist(
        point,
        [stop[1], stop[2]]
      );

      if (distance <= radius) {
        matches.push({
          id,
          walk: distance,
          minutes: distance / 75
        });
      }
    }

    return matches
      .sort((a, b) => a.walk - b.walk)
      .slice(0, limit);
  }

  // Pregătește plecările din orarele CTP
  function prepareEvents(now) {
    const departures = new Map();

    for (const trip of gtfs.trips) {
      if (!active(gtfs.calendar[trip[1]], now)) {
        continue;
      }

      const item = {
        route: trip[0],
        service: trip[1],
        shape: trip[2],
        headsign: trip[3],
        stops: trip[4]
      };

      for (
        let i = 0;
        i < item.stops.length - 1;
        i++
      ) {
        const [id, , departure] = item.stops[i];

        if (
          departure < now.minute - 5 ||
          departure > now.minute + 180
        ) {
          continue;
        }

        if (!departures.has(id)) {
          departures.set(id, []);
        }

        departures.get(id).push({
          trip: item,
          index: i,
          time: departure
        });
      }
    }

    for (const events of departures.values()) {
      events.sort((a, b) => a.time - b.time);
    }

    return departures;
  }

  // Caută călătorii directe sau cu o schimbare
  function searchTransit(now) {
    const origins = nearby(start);
    const destinations = nearby(end);

    if (!origins.length || !destinations.length) {
      throw Error(
        'Nu există stații la maximum 950 m de unul dintre puncte.'
      );
    }

    const target = new Map(
      destinations.map(stop => [stop.id, stop])
    );

    const departures = prepareEvents(now);

    let best = null;

    function consider(legs, walkA, walkB, arrive) {
      const finish = arrive + walkB.minutes;

      if (!best || finish < best.finish) {
        best = {
          legs,
          walkA,
          walkB,
          finish
        };
      }
    }

    // Călătorii directe
    for (const origin of origins) {
      for (const event of departures.get(origin.id) || []) {
        if (
          event.time <
          now.minute + origin.minutes + 2
        ) {
          continue;
        }

        const stops = event.trip.stops;

        for (
          let j = event.index + 1;
          j < stops.length;
          j++
        ) {
          const destination = target.get(stops[j][0]);

          if (!destination) {
            continue;
          }

          consider(
            [{
              trip: event.trip,
              from: event.index,
              to: j,
              departure: event.time,
              arrival: stops[j][1]
            }],
            origin,
            destination,
            stops[j][1]
          );
        }
      }
    }

    // Călătorii cu o schimbare în aceeași stație
    for (const origin of origins) {
      const first = (
        departures.get(origin.id) || []
      )
        .filter(
          event =>
            event.time >=
            now.minute + origin.minutes + 2
        )
        .slice(0, 35);

      for (const event of first) {
        const firstStops = event.trip.stops;

        for (
          let j = event.index + 1;
          j < firstStops.length;
          j++
        ) {
          const transfer = firstStops[j];
          const arrive = transfer[1];

          if (best && arrive >= best.finish) {
            break;
          }

          const next =
            departures.get(transfer[0]) || [];

          let examined = 0;

          for (const event2 of next) {
            if (
              event2.trip === event.trip ||
              event2.time < arrive + 3
            ) {
              continue;
            }

            if (event2.time > arrive + 35) {
              break;
            }

            if (++examined > 14) {
              break;
            }

            const second = event2.trip.stops;

            for (
              let k = event2.index + 1;
              k < second.length;
              k++
            ) {
              const destination =
                target.get(second[k][0]);

              if (!destination) {
                continue;
              }

              consider(
                [
                  {
                    trip: event.trip,
                    from: event.index,
                    to: j,
                    departure: event.time,
                    arrival: arrive
                  },
                  {
                    trip: event2.trip,
                    from: event2.index,
                    to: k,
                    departure: event2.time,
                    arrival: second[k][1]
                  }
                ],
                origin,
                destination,
                second[k][1]
              );
            }
          }
        }
      }
    }

    return best;
  }

  // Desenează schematic traseul dintre stații
  function transitLine(leg) {
    const stops = leg.trip.stops.slice(
      leg.from,
      leg.to + 1
    );

    const coords = stops
      .map(stop => stopLatLng(stop[0]))
      .filter(Boolean);

    return L.polyline(coords, {
      color: '#f5a524',
      weight: 6,
      opacity: 0.9
    }).addTo(lines);
  }

  // Afișează călătoria cu transport public
  function showTransit(plan, now) {
    lines.clearLayers();

    const bounds = L.latLngBounds([]);

    const firstLeg = plan.legs[0];

    const origin = stopLatLng(
      firstLeg.trip.stops[firstLeg.from][0]
    );

    const lastLeg = plan.legs.at(-1);

    const finish = stopLatLng(
      lastLeg.trip.stops[lastLeg.to][0]
    );

    const walk1 = L.polyline(
      [start, origin],
      {
        color: '#64748b',
        weight: 3,
        dashArray: '6 6'
      }
    ).addTo(lines);

    const walk2 = L.polyline(
      [finish, end],
      {
        color: '#64748b',
        weight: 3,
        dashArray: '6 6'
      }
    ).addTo(lines);

    bounds.extend(walk1.getBounds());
    bounds.extend(walk2.getBounds());

    let rideKm = 0;
    let emissions = 0;

    const steps = [
      'Mergi aproximativ ' +
      Math.round(plan.walkA.walk) +
      ' m până la stația ' +
      gtfs.stops[plan.walkA.id][0] +
      '.'
    ];

    for (const [i, leg] of plan.legs.entries()) {
      const route = gtfs.routes[leg.trip.route];

      const label = route ? route[0] : '?';

      const type =
        route && route[2] === 0
          ? 'tramvai'
          : 'autobuz';

      const from =
        gtfs.stops[
          leg.trip.stops[leg.from][0]
        ][0];

      const to =
        gtfs.stops[
          leg.trip.stops[leg.to][0]
        ][0];

      const poly = transitLine(leg);

      bounds.extend(poly.getBounds());

      const stopCoords = leg.trip.stops
        .slice(leg.from, leg.to + 1)
        .map(stop => stopLatLng(stop[0]));

      let km = 0;

      for (
        let j = 1;
        j < stopCoords.length;
        j++
      ) {
        km +=
          dist(
            stopCoords[j - 1],
            stopCoords[j]
          ) / 1000;
      }

      rideKm += km;

      emissions +=
        km *
        FACTORS[
          type === 'tramvai'
            ? 'tram'
            : 'bus'
        ];

      steps.push(
        (i ? 'Schimbă cu ' : 'Ia ') +
        (type === 'tramvai' ? 'tramvaiul ' : 'autobuzul ') +
        label +
        ', direcția ' +
        leg.trip.headsign +
        ', din ' +
        from +
        ' la ' +
        to +
        ' (' +
        fmtTime(leg.departure) +
        '–' +
        fmtTime(leg.arrival) +
        ').'
      );

      if (i < plan.legs.length - 1) {
        steps.push(
          'Schimbă vehiculul în stația ' +
          to +
          '; verifică peronul și orarul.'
        );
      }
    }

    steps.push(
      'Mergi aproximativ ' +
      Math.round(plan.walkB.walk) +
      ' m până la destinație.'
    );

    const walkKm =
      (plan.walkA.walk + plan.walkB.walk) / 1000;

    const minutes =
      plan.finish - now.minute;

    result(
      rideKm + walkKm,
      minutes,
      emissions,
      'Transport în comun · ' +
      plan.legs.length +
      (plan.legs.length === 1
        ? ' linie'
        : ' linii'),
      'Orar programat CTP Iași. ' +
      'Traseul portocaliu unește stațiile și este schematic. ' +
      'Distanța și CO₂ sunt estimative. ' +
      'Nu sunt date în timp real.'
    );

    instructions(steps);

    map.fitBounds(bounds, {
      padding: [35, 35],
      maxZoom: 15
    });

    setStatus(
      'Călătorie găsită în orarul CTP. ' +
      'Verifică orele și eventualele modificări de serviciu.'
    );
  }

  // Funcția principală
  async function calculate() {
    if (busy) return;

    if (!start || !end) {
      setStatus(
        'Selectează plecarea și destinația.'
      );
      return;
    }

    if (dist(start, end) < 30) {
      setStatus(
        'Alege două puncte mai îndepărtate.'
      );
      return;
    }

    busy = true;

    const button = $('calculate');

    button.disabled = true;
    button.textContent = 'Se calculează...';

    resetResults();

    try {
      const mode = $('mode').value;

      if (mode === 'public') {
        await loadGTFS();

        const now = iasiNow();
        const plan = searchTransit(now);

        if (!plan) {
          throw Error(
            'Nu am găsit o legătură directă sau cu o schimbare ' +
            'în următoarele 3 ore. ' +
            'Încearcă puncte mai apropiate de stații.'
          );
        }

        showTransit(plan, now);
      } else {
        setStatus('Se calculează ruta...');

        await roadRoute(
          mode,
          $('priority').value
        );
      }
    } catch (error) {
      console.error(error);

      setStatus(
        'Nu s-a putut calcula ruta: ' +
        error.message
      );
    } finally {
      busy = false;

      button.disabled = false;
      button.textContent = 'Calculează ruta';
    }
  }

  // Butoanele site-ului
  $('calculate').addEventListener(
    'click',
    calculate
  );

  $('reset').addEventListener(
    'click',
    reset
  );

  $('center').addEventListener(
    'click',
    () => map.setView(IASI, 13)
  );

  for (const id of ['mode', 'priority']) {
    $(id).addEventListener('change', () => {
      if (busy) return;

      resetResults();

      setStatus(
        'Apasă „Calculează ruta” pentru noua opțiune.'
      );
    });
  }

  // Recalculează dimensiunea hărții
  // fără actualizări excesive
  window.addEventListener(
    'load',
    () => {
      map.invalidateSize({
        pan: false
      });
    },
    { once: true }
  );

  let resizeFrame = 0;

  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);

    resizeFrame = requestAnimationFrame(() => {
      map.invalidateSize({
        pan: false
      });
    });
  });
});
