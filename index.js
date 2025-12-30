const axios = require("axios");

// ======= CONFIG =======
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const HUBSPOT_BASE = "https://api.hubapi.com";
const DOLAR_API_URL = "https://dolarapi.com/v1/dolares/oficial";

const TC_PROPERTY = "tc_presupuesto_ars_usd";
const FECHA_TC_PROPERTY = "fecha_tc_presupuesto";

const LOOKBACK_MINUTES = 10;
const MAX_RETRIES = 6;
// ======================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCloudflareBlock(status, data) {
  if (status !== 403) return false;
  const text = typeof data === "string" ? data : JSON.stringify(data || "");
  const t = text.toLowerCase();
  return (
    t.includes("cloudflare") ||
    t.includes("error 1006") ||
    t.includes("access denied") ||
    t.includes("banned your ip address")
  );
}

async function requestWithRetry(config) {
  let lastErr;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await axios.request({
        timeout: 20000,
        validateStatus: () => true, // manejamos nosotros status codes
        ...config,
      });
    } catch (err) {
      lastErr = err;
      const backoff = Math.min(30000, 2000 * 2 ** (attempt - 1)) + Math.random() * 1500;
      console.log(`[http] Network error: ${err.message}. Reintentando en ${(backoff/1000).toFixed(1)}s (${attempt}/${MAX_RETRIES})`);
      await sleep(backoff);
    }

    // si fue excepción de red, ya reintentó arriba
    // el resto (status codes) se maneja abajo cuando hay respuesta
  }

  throw lastErr || new Error("requestWithRetry: falló sin error explícito");
}

async function hubspotRequest(method, path, body) {
  const url = `${HUBSPOT_BASE}${path}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await requestWithRetry({
      method,
      url,
      headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      data: body,
    });

    // OK
    if (res.status >= 200 && res.status < 300) return res.data;

    // 429 rate limit
    if (res.status === 429) {
      const ra = res.headers?.["retry-after"];
      const waitMs = (ra ? Number(ra) * 1000 : 2000 * 2 ** (attempt - 1)) + Math.random() * 1500;
      console.log(`[hubspot] 429 rate limit. Reintentando en ${(waitMs/1000).toFixed(1)}s (${attempt}/${MAX_RETRIES})`);
      await sleep(waitMs);
      continue;
    }

    // 403 Cloudflare block (HTML)
    if (isCloudflareBlock(res.status, res.data)) {
      const waitMs = Math.min(120000, 10000 * attempt) + Math.random() * 3000;
      console.log(`[hubspot] 403 Cloudflare/1006. Reintentando en ${(waitMs/1000).toFixed(1)}s (${attempt}/${MAX_RETRIES})`);
      await sleep(waitMs);
      continue;
    }

    // 5xx transient
    if (res.status >= 500 && res.status < 600) {
      const waitMs = Math.min(30000, 2000 * 2 ** (attempt - 1)) + Math.random() * 1500;
      console.log(`[hubspot] ${res.status} server error. Reintentando en ${(waitMs/1000).toFixed(1)}s (${attempt}/${MAX_RETRIES})`);
      await sleep(waitMs);
      continue;
    }

    // otros 4xx -> error real (token, permisos, payload)
    const preview =
      typeof res.data === "string"
        ? res.data.slice(0, 500)
        : JSON.stringify(res.data).slice(0, 500);

    throw new Error(`${method} ${path} -> ${res.status} | ${preview}`);
  }

  throw new Error(`${method} ${path} -> falló tras ${MAX_RETRIES} reintentos`);
}

async function obtenerTipoCambio() {
  const res = await axios.get(DOLAR_API_URL, { timeout: 15000 });
  const data = res.data;
  const tc = data.venta;
  const fechaIso = data.fechaActualizacion;
  return { tc, fechaIso };
}

function fechaHaceMinutos(min) {
  const d = new Date();
  d.setMinutes(d.getMinutes() - min);
  return d.toISOString();
}

async function buscarDealsModificadosRecientemente() {
  const body = {
    filterGroups: [
      {
        filters: [
          {
            propertyName: "hs_lastmodifieddate",
            operator: "GTE",
            value: fechaHaceMinutos(LOOKBACK_MINUTES),
          },
        ],
      },
    ],
    properties: ["amount", TC_PROPERTY],
    limit: 100,
  };

  return await hubspotRequest("POST", "/crm/v3/objects/deals/search", body);
}

async function actualizarDealsEnLote(deals, tc, fechaIso) {
  if (!deals.length) return;

  const inputs = deals.map((deal) => ({
    id: deal.id,
    properties: {
      [TC_PROPERTY]: tc.toString(),
      [FECHA_TC_PROPERTY]: fechaIso.split("T")[0],
    },
  }));

  await hubspotRequest("POST", "/crm/v3/objects/deals/batch/update", { inputs });
}

async function main() {
  try {
    if (!HUBSPOT_TOKEN) {
      throw new Error("Falta la variable de entorno HUBSPOT_TOKEN");
    }

    // Jitter para evitar picos sincronizados
    const jitterMs = Math.floor(Math.random() * 20000);
    await sleep(jitterMs);

    console.log("Obteniendo tipo de cambio desde dolarapi...");
    const { tc, fechaIso } = await obtenerTipoCambio();
    console.log(`TC actual: ${tc} ARS/USD - Fecha: ${fechaIso}`);

    console.log(`Buscando deals modificados en los últimos ${LOOKBACK_MINUTES} minutos...`);
    const searchRes = await buscarDealsModificadosRecientemente();
    const deals = searchRes?.results || [];
    console.log(`Deals encontrados: ${deals.length}`);

    const dealsConAmount = deals.filter((d) => {
      const amount = d.properties?.amount;
      return amount !== null && amount !== undefined && amount !== "";
    });

    console.log(`Deals con amount no vacío: ${dealsConAmount.length}`);

    if (!dealsConAmount.length) {
      console.log("No hay deals para actualizar.");
      return;
    }

    console.log("Actualizando tipo de cambio histórico en lote...");
    await actualizarDealsEnLote(dealsConAmount, tc, fechaIso);

    console.log("Proceso completado.");
  } catch (err) {
    console.error("Error en el proceso:", err.message);
    process.exit(1);
  }
}

main();
