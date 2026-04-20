/**
 * daemon.js — Worker de polling Notion → ARCA
 * ============================================
 * Corre permanentemente en Railway.
 * Cada 30 segundos consulta la DB de Notion buscando registros
 * con Estado = "🚀 Emitir" o "🗑️ Anular" y los procesa.
 */
"use strict";

const { Client } = require("@notionhq/client");
const emitir     = require("./lib/emitir");
const anular     = require("./lib/anular");

const NOTION_TOKEN    = process.env.NOTION_TOKEN;
const NOTION_DB_ID    = process.env.NOTION_DB_ID;
const POLL_INTERVAL   = parseInt(process.env.POLL_INTERVAL_MS || "30000");
const PRODUCCION      = process.env.AMBIENTE !== "homologacion";

if (!NOTION_TOKEN || !NOTION_DB_ID) {
    console.error("❌ Faltan variables de entorno: NOTION_TOKEN y/o NOTION_DB_ID");
    process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });

console.log("═".repeat(65));
console.log(`  Facturador ARCA — Daemon v1.0`);
console.log(`  Ambiente  : ${PRODUCCION ? "PRODUCCIÓN ⚠️" : "HOMOLOGACIÓN"}`);
console.log(`  Polling   : cada ${POLL_INTERVAL / 1000}s`);
console.log(`  Notion DB : ${NOTION_DB_ID}`);
console.log("═".repeat(65));

// ══════════════════════════════════════════════════════════════
//  LOOP PRINCIPAL
// ══════════════════════════════════════════════════════════════

async function poll() {
    try {
        // Buscar registros pendientes
        const res = await notion.databases.query({
            database_id: NOTION_DB_ID,
            filter: {
                or: [
                    { property: "Estado", select: { equals: "🚀 Emitir" } },
                    { property: "Estado", select: { equals: "🗑️ Anular" } },
                ]
            }
        });

        if (res.results.length === 0) return;

        console.log(`\n[${new Date().toLocaleTimeString("es-AR")}] ${res.results.length} registro(s) pendiente(s)`);

        for (const page of res.results) {
            const estado = page.properties["Estado"]?.select?.name;
            const nombre = page.properties["Razón Social"]?.title?.[0]?.plain_text || "?";

            // Marcar como "en proceso" para evitar doble ejecución
            await notion.pages.update({
                page_id: page.id,
                properties: { "Estado": { select: { name: "⏳ Procesando" } } }
            });

            try {
                if (estado === "🚀 Emitir") {
                    console.log(`  → Emitiendo: ${nombre}`);
                    const resultado = await emitir.procesarPagina(page, PRODUCCION);
                    await actualizarExito(page.id, resultado);
                    console.log(`  ✅ CAE: ${resultado.cae} | Nro: ${resultado.nro}`);

                } else if (estado === "🗑️ Anular") {
                    console.log(`  → Anulando: ${nombre}`);
                    const resultado = await anular.procesarPagina(page, PRODUCCION);
                    await actualizarAnulacion(page.id, resultado);
                    console.log(`  ✅ NC Nro: ${resultado.nro} | CAE: ${resultado.cae}`);
                }

            } catch (err) {
                console.error(`  ❌ Error en ${nombre}: ${err.message}`);
                await notion.pages.update({
                    page_id: page.id,
                    properties: {
                        "Estado": { select: { name: "❌ Rechazada" } },
                        "Error":  { rich_text: [{ text: { content: err.message.substring(0, 500) } }] }
                    }
                });
            }
        }

    } catch (err) {
        console.error(`[Poll error] ${err.message}`);
    }
}

async function actualizarExito(pageId, res) {
    const props = {
        "Estado":          { select:    { name: "✅ Aprobada" } },
        "Nro Comprobante": { number:    res.nro },
        "CAE":             { rich_text: [{ text: { content: String(res.cae) } }] },
        "CAE Vencimiento": { date:      { start: res.cae_vto_iso } },
        "Error":           { rich_text: [] }
    };
    await notion.pages.update({ page_id: pageId, properties: props });
}

async function actualizarAnulacion(pageId, res) {
    const props = {
        "Estado":          { select:    { name: "🔄 Anulada" } },
        "Nro Comprobante": { number:    res.nro },
        "CAE":             { rich_text: [{ text: { content: String(res.cae) } }] },
        "CAE Vencimiento": { date:      { start: res.cae_vto_iso } },
        "Error":           { rich_text: [] }
    };
    await notion.pages.update({ page_id: pageId, properties: props });
}

// ══════════════════════════════════════════════════════════════
//  INICIO
// ══════════════════════════════════════════════════════════════

async function run() {
    await poll(); // Ejecución inmediata al arrancar
    setInterval(poll, POLL_INTERVAL);
}

run();
