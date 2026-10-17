
// CarbonIt - harta, rute si emisii CO2

/* ========================================
   CARBONIT | GREEN MAP IASI
   APP.JS
   ======================================== */

document.addEventListener("DOMContentLoaded", () => {
  "use strict";

  const $ = id => document.getElementById(id);

  const mapElement = $("map");
  const statusElement = $("status");

  if (!mapElement || !statusElement) {
    console.error("Elementele hartii lipsesc.");
    return;
  }

  if (typeof L === "undefined") {
    statusElement.textContent =
      "Biblioteca Leaflet nu s-a incarcat.";
    return;
  }

  const IASI = [47.1585, 27.6014];

  const ROUTING_API =
    "https://valhalla1.openstreetmap.de/route";

  // Factori demonstrativi de emisii directe
  // kg CO2 / pasager-km
  const EMISSIONS = {
    pedestrian: 0,
    bicycle: 0,
    auto: 0.15,
    bus: 0.08,
    tram: 0.035
  };

  let start = null;
  let destination = null;
  let calculating = false;

  let currentRoute = null;
  let routeGeneration = 0;

  const map = L.map("map", {
    center: IASI,
    zoom: 13,
    preferCanvas: true,
    zoomAnimation: false,
    fadeAnimation: false,
    markerZoomAnimation: false
  });

  const tiles = L.tileLayer(
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      updateWhenIdle: true,
      keepBuffer: 3,
      attribution:
        "&copy; OpenStreetMap contributors"
    }
  ).addTo(map);

  tiles.on("tileerror", () => {
    console.warn("O imagine a hartii nu s-a incarcat.");
  });

  const pointsLayer = L.layerGroup().addTo(map);
  const routesLayer = L.layerGroup().addTo(map);

  function setStatus(message) {
    statusElement.textContent = message;
  }

  function formatDuration(minutes) {
    const value = Math.round(minutes);

    if (value < 60) {
      return value + " min";
    }

    const hours = Math.floor(value / 60);
    const remaining = value % 60;

    return `${hours} h ${remaining} min`;
  }

  function resetResults() {
    routesLayer.clearLayers();
    currentRoute = null;

    $("distance").textContent = "—";
    $("duration").textContent = "—";
    $("co2").textContent = "—";

    const card = $("routeInfo");

    if (card) {
      card.hidden = true;
    }

    const instructions = $("instructions");

    if (instructions) {
      instructions.replaceChildren();
    }
  }

  function addPoint(point, isStart) {
    const marker = L.circleMarker(point, {
      radius: 9,
      weight: 3,
      color: "#ffffff",
      fillColor: isStart
        ? "#20c997"
        : "#eb5757",
      fillOpacity: 1
    });

    marker.addTo(pointsLayer);

    marker.bindPopup(
      isStart
        ? "Punct de plecare"
        : "Destinatie"
    );
  }

  function resetMap() {
    if (calculating) return;

    routeGeneration++;

    start = null;
    destination = null;

    pointsLayer.clearLayers();
    resetResults();

    setStatus(
      "Selecteaza punctul de plecare pe harta."
    );
  }

  map.on("click", event => {
    if (calculating) return;

    if (!start) {
      start = event.latlng;
      addPoint(start, true);

      setStatus(
        "Acum selecteaza destinatia."
      );

      return;
    }

    if (!destination) {
      destination = event.latlng;
      addPoint(destination, false);

      setStatus(
        "Apasa Calculeaza ruta."
      );

      return;
    }

    resetMap();

    start = event.latlng;
    addPoint(start, true);

    setStatus(
      "Selecteaza noua destinatie."
    );
  });

  function decodePolyline(encoded, precision = 6) {
    let index = 0;
    let latitude = 0;
    let longitude = 0;

    const coordinates = [];
    const factor = 10 ** precision;

    while (index < encoded.length) {
      const values = [];

      for (let j = 0; j < 2; j++) {
        let result = 0;
        let shift = 0;
        let byte;

        do {
          if (index >= encoded.length) {
            throw new Error(
              "Geometrie de ruta incompleta."
            );
          }

          byte = encoded.charCodeAt(index++) - 63;
          result |= (byte & 31) << shift;
          shift += 5;

        } while (byte >= 32);

        values.push(
          result & 1
            ? ~(result >> 1)
            : result >> 1
        );
      }

      latitude += values[0];
      longitude += values[1];

      coordinates.push([
        latitude / factor,
        longitude / factor
      ]);
    }

    return coordinates;
  }

  function getCostingOptions(mode, priority) {
    if (mode === "auto") {
      return {
        auto: {
          shortest: priority === "green"
        }
      };
    }

    if (mode === "bicycle") {
      return {
        bicycle: {
          bicycle_type: "hybrid",
          use_roads:
            priority === "green" ? 0.2 : 0.6
        }
      };
    }

    return {
      pedestrian: {
        use_hills:
          priority === "green" ? 0.3 : 0.5
      }
    };
  }

  async function fetchRoute(mode, priority) {
    const request = {
      locations: [
        {
          lat: start.lat,
          lon: start.lng
        },
        {
          lat: destination.lat,
          lon: destination.lng
        }
      ],
      costing: mode,
      costing_options:
        getCostingOptions(mode, priority),
      units: "kilometers",
      shape_format: "polyline6",
      language: "ro-RO"
    };

    const url =
      ROUTING_API +
      "?json=" +
      encodeURIComponent(JSON.stringify(request));

    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      20000
    );

    try {
      const response = await fetch(url, {
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(
          "Serviciul de rutare nu este disponibil."
        );
      }

      const data = await response.json();

      if (!data.trip || !data.trip.legs?.length) {
        throw new Error(
          "Nu a fost gasita o ruta."
        );
      }

      const coordinates = [];
      const maneuvers = [];

      data.trip.legs.forEach((leg, index) => {
        const points = decodePolyline(leg.shape);

        if (index > 0) {
          points.shift();
        }

        coordinates.push(...points);

        if (leg.maneuvers) {
          maneuvers.push(...leg.maneuvers);
        }
      });

      return {
        coordinates,
        maneuvers,
        distance: data.trip.summary.length,
        minutes: data.trip.summary.time / 60
      };

    } finally {
      clearTimeout(timeout);
    }
  }

  function displayInstructions(maneuvers) {
    const list = $("instructions");

    if (!list) return;

    list.replaceChildren();

    if (!maneuvers.length) {
      const li = document.createElement("li");
      li.textContent =
        "Urmeaza traseul afisat pe harta.";
      list.appendChild(li);
      return;
    }

    maneuvers.forEach(maneuver => {
      const li = document.createElement("li");
      li.textContent =
        maneuver.instruction ||
        "Continua pe traseu.";
      list.appendChild(li);
    });
  }

  function displayRoute(route, mode, priority) {
    routesLayer.clearLayers();

    const color =
      priority === "green"
        ? "#20b56d"
        : "#3898ed";

    const line = L.polyline(
      route.coordinates,
      {
        color,
        weight: 6,
        opacity: 0.95
      }
    ).addTo(routesLayer);

    map.fitBounds(line.getBounds(), {
      padding: [35, 35],
      maxZoom: 16
    });

    const factor = EMISSIONS[mode] ?? 0;

    const emissions =
      route.distance * factor;

    $("distance").textContent =
      route.distance.toFixed(2) + " km";

    $("duration").textContent =
      formatDuration(route.minutes);

    $("co2").textContent =
      emissions.toFixed(2) + " kg";

    const label = $("co2Label");

    if (label) {
      label.textContent =
        "CO₂ estimat";
    }

    const info = $("routeInfo");

    if (info) {
      info.hidden = false;
    }

    const title = $("routeTitle");

    if (title) {
      title.textContent =
        priority === "green"
          ? "Ruta verde"
          : "Ruta utilizata";
    }

    const description = $("routeDescription");

    if (description) {
      description.textContent =
        "Emisii estimate pentru mijlocul " +
        "de transport selectat.";
    }

    displayInstructions(route.maneuvers);

    setStatus("Ruta a fost calculata.");
  }

  async function calculateRoute() {
    if (calculating) return;

    if (!start || !destination) {
      setStatus(
        "Selecteaza plecarea si destinatia."
      );
      return;
    }

    const mode = $("mode").value;
    const priority = $("priority").value;

    if (mode === "public") {
      setStatus(
        "Transportul public necesita " +
        "datele CTP Iasi. Vom integra " +
        "traseele de autobuz si tramvai " +
        "in etapa urmatoare."
      );

      return;
    }

    const generation = ++routeGeneration;

    calculating = true;

    const button = $("calculate");
    button.disabled = true;
    button.textContent = "Se calculeaza...";

    resetResults();

    setStatus("Se calculeaza ruta...");

    try {
      const route =
        await fetchRoute(mode, priority);

      if (generation !== routeGeneration) {
        return;
      }

      currentRoute = route;

      displayRoute(route, mode, priority);

    } catch (error) {
      console.error(error);

      setStatus(
        "Nu am putut calcula ruta. " +
        "Incearca din nou."
      );

    } finally {
      calculating = false;

      button.disabled = false;
      button.textContent = "Calculeaza ruta";
    }
  }

  $("calculate").addEventListener(
    "click",
    calculateRoute
  );

  $("reset").addEventListener(
    "click",
    resetMap
  );

  $("center").addEventListener(
    "click",
    () => map.setView(IASI, 13)
  );

  $("mode").addEventListener(
    "change",
    () => {
      resetResults();

      setStatus(
        "Mijloc de transport schimbat. " +
        "Calculeaza din nou ruta."
      );
    }
  );

  $("priority").addEventListener(
    "change",
    () => {
      resetResults();

      setStatus(
        "Preferinta schimbata. " +
        "Calculeaza din nou ruta."
      );
    }
  );

  // Corectie simpla pentru redimensionare.
  // Evitam observatoare care pot produce
  // recalculari excesive si lag.

  window.addEventListener(
    "load",
    () => {
      map.invalidateSize({
        pan: false
      });
    },
    { once: true }
  );

  window.addEventListener(
    "resize",
    () => {
      map.invalidateSize({
        pan: false
      });
    }
  );

});
