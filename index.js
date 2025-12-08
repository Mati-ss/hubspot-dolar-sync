const axios = require("axios");

// ======= CONFIGURACIÓN =======
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const DOLAR_API_URL = "https://dolarapi.com/v1/dolares/oficial";

// Nombres internos de propiedades en HubSpot
const TC_PROPERTY = "tc_presupuesto_ars_usd";
const FECHA_TC_PROPERTY = "fecha_tc_presupuesto";
// amount es la estándar de HubSpot para el valor del negocio

// Ventana de tiempo para buscar deals actualizados recientemente (en minutos)
const LOOKBACK_MINUTES = 10;

// =============================

async function obtenerTipoCambio() {
  const resp = await axios.get(DOLAR_API_URL, { timeout: 10000 });
  const data = resp.data;
  // Elegimos el valor de venta (podés cambiar a compra o promedio)
  const tc = data.venta;
  const fechaIso = data.fechaActualizacion; // formato ISO
  return { tc, fechaIso };
}

function fechaHaceMinutos(min) {
  const d = new Date();
  d.setMinutes(d.getMinutes() - min);
  return d.toISOString();
}

async function buscarDealsModificadosRecientemente() {
  const url = "https://api.hubapi.com/crm/v3/objects/deals/search";

  const headers = {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    "Content-Type": "application/json",
  };

  // Buscamos deals cuyo hs_lastmodifieddate sea dentro de los últimos X minutos
  const haceUnRato = fechaHaceMinutos(LOOKBACK_MINUTES);

  const body = {
    filterGroups: [
      {
        filters: [
          {
            propertyName: "hs_lastmodifieddate",
            operator: "GTE",
            value: haceUnRato,
          },
        ],
      },
    ],
    properties: ["amount", TC_PROPERTY],
    limit: 100,
  };

  const resp = await axios.post(url, body, { headers, timeout: 15000 });
  return resp.data.results || [];
}

async function actualizarDealsEnLote(deals, tc, fechaIso) {
  if (!deals.length) return;

  const url = "https://api.hubapi.com/crm/v3/objects/deals/batch/update";

  const headers = {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    "Content-Type": "application/json",
  };

  const inputs = deals.map((deal) => ({
    id: deal.id,
    properties: {
      [TC_PROPERTY]: tc.toString(),
      [FECHA_TC_PROPERTY]: fechaIso.split("T")[0] // solo fecha YYYY-MM-DD
    },
  }));

  const body = { inputs };

  const resp = await axios.post(url, body, { headers, timeout: 20000 });
  return resp.data;
}

async function main() {
  try {
    if (!HUBSPOT_TOKEN) {
      throw new Error("Falta la variable de entorno HUBSPOT_TOKEN");
    }

    console.log("Obteniendo tipo de cambio desde dolarapi...");
    const { tc, fechaIso } = await obtenerTipoCambio();
    console.log(`TC actual: ${tc} ARS/USD - Fecha: ${fechaIso}`);

    console.log(`Buscando deals modificados en los últimos ${LOOKBACK_MINUTES} minutos...`);
    const deals = await buscarDealsModificadosRecientemente();
    console.log(`Deals encontrados: ${deals.length}`);

    // Podrías filtrar aquí solo los deals que tengan amount no vacío
    const dealsConAmount = deals.filter((d) => {
      const amount = d.properties?.amount;
      return amount !== null && amount !== undefined && amount !== "";
    });

    console.log(`Deals con amount no vacío: ${dealsConAmount.length}`);

    // Si tienes más de 100, podrías paginar. Para arrancar, asumimos <=100 por ciclo.
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

