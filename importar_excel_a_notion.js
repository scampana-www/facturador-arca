/**
 * importar_excel_a_notion.js — Importación única del historial de facturas
 * =========================================================================
 * Ejecutar UNA SOLA VEZ desde tu PC local para migrar el Excel a Notion.
 *
 * Uso:
 *   npm install exceljs @notionhq/client
 *   node importar_excel_a_notion.js
 *
 * Requiere en el mismo directorio:
 *   - facturas_RESULTADO.xlsx  (o facturas.xlsx)
 *   - .env con NOTION_TOKEN y NOTION_DB_ID
 */
"use strict";

require("dotenv").config();
const ExcelJS       = require("exceljs");
const { Client }    = require("@notionhq/client");
const path          = require("path");
const fs            = require("fs");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DB_ID;

if (!NOTION_TOKEN || !NOTION_DB_ID) {
    console.error("❌ Crear un archivo .env con NOTION_TOKEN y NOTION_DB_ID");
    process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });

// ── Buscar el Excel más completo disponible ──────────────────
const CANDIDATOS = ["facturas_RESULTADO.xlsx", "facturas.xlsx"];
let EXCEL_PATH = null;
for (const c of CANDIDATOS) {
    const p = path.resolve(__dirname, c);
    if (fs.existsSync(p)) { EXCEL_PATH = p; break; }
}
if (!EXCEL_PATH) {
    console.error("❌ No se encontró facturas_RESULTADO.xlsx ni facturas.xlsx");
    process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function celdaAFechaISO(v) {
    if (!v) return null;
    if (v instanceof Date) {
        const p = n => String(n).padStart(2, "0");
        return `${v.getUTCFullYear()}-${p(v.getUTCMonth()+1)}-${p(v.getUTCDate())}`;
    }
    const s = String(v).trim();
    // DD/MM/AAAA
    const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m1) return `${m1[3]}-${m1[2].padStart(2,"0")}-${m1[1].padStart(2,"0")}`;
    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return null;
}

async function main() {
    console.log(`📂 Leyendo: ${path.basename(EXCEL_PATH)}`);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(EXCEL_PATH);
    const ws = wb.getWorksheet("Facturas") || wb.worksheets[0];

    // Detectar fila de encabezado
    let filaEnc = -1, col = {};
    for (let i = 1; i <= 10; i++) {
        const row = ws.getRow(i);
        let encontrado = false;
        row.eachCell({ includeEmpty: false }, (cell, idx) => {
            const h = String(cell.value || "").toLowerCase()
                .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            if (h.includes("cuit"))          { col.cuit = idx; encontrado = true; }
            if (h.includes("social") || h.includes("nombre")) col.nombre = idx;
            if (h.includes("fecha") && !h.includes("venc") && !h.includes("cae")) col.fecha = idx;
            if (h.includes("importe") || h.includes("total")) col.importe = idx;
            if (h.includes("desde"))         col.desde = idx;
            if (h.includes("hasta"))         col.hasta = idx;
            if (h.includes("nro") || (h.includes("comp") && !h.includes("cond"))) col.nro = idx;
            if (h.includes("cae") && !h.includes("venc") && !h.includes("vto"))  col.cae = idx;
            if (h.includes("venc") || h.includes("vto"))  col.vto = idx;
            if (h.includes("estado"))        col.estado = idx;
            if (h.includes("domicilio") || h.includes("direccion")) col.domicilio = idx;
            if (h.includes("condicion") && h.includes("iva"))   col.condIva = idx;
            if (h.includes("condicion") && h.includes("venta")) col.condVenta = idx;
        });
        if (encontrado) { filaEnc = i; break; }
    }

    if (filaEnc === -1) {
        console.error("❌ No se encontró la fila de encabezados.");
        process.exit(1);
    }

    const facturas = [];
    ws.eachRow((row, rowIdx) => {
        if (rowIdx <= filaEnc) return;
        const g = (c) => {
            if (!col[c]) return null;
            const v = row.getCell(col[c]).value;
            return (v && typeof v === "object" && v.richText)
                ? v.richText.map(r => r.text).join("")
                : (v ?? null);
        };

        const cuit = String(g("cuit") || "").replace(/[^0-9]/g, "");
        if (!cuit || cuit.length < 10) return;

        const rawImp = g("importe");
        const imp = typeof rawImp === "number"
            ? rawImp
            : parseFloat(String(rawImp || "0").replace(/[^0-9.,]/g, "").replace(",", "."));
        if (!imp || imp <= 0) return;

        facturas.push({
            razon_social:  String(g("nombre") || "").trim().substring(0, 100),
            cuit_cliente:  cuit,
            fecha:         celdaAFechaISO(g("fecha")),
            importe:       imp,
            periodo_desde: celdaAFechaISO(g("desde")),
            periodo_hasta: celdaAFechaISO(g("hasta")),
            nro:           g("nro") ? parseInt(String(g("nro")).replace(/[^0-9]/g, "")) : null,
            cae:           g("cae") ? String(g("cae")).trim() : null,
            cae_vto:       celdaAFechaISO(g("vto")),
            estado:        g("estado") ? String(g("estado")).trim() : null,
            domicilio:     g("domicilio") ? String(g("domicilio")).trim() : "",
            cond_iva:      g("condIva")   ? String(g("condIva")).trim()   : "Consumidor Final",
            cond_venta:    g("condVenta") ? String(g("condVenta")).trim() : "Contado",
        });
    });

    console.log(`📋 ${facturas.length} registros encontrados. Importando a Notion...`);

    let ok = 0, err = 0;
    for (let i = 0; i < facturas.length; i++) {
        const f = facturas[i];
        process.stdout.write(`  [${i+1}/${facturas.length}] ${f.razon_social.padEnd(25)} `);

        try {
            // Mapear estado de Excel a opciones de Notion
            let estadoNotion = "✅ Aprobada";
            if (f.estado) {
                const e = f.estado.toLowerCase();
                if (e.includes("rechaz"))  estadoNotion = "❌ Rechazada";
                if (e.includes("anul"))    estadoNotion = "🔄 Anulada";
            }
            if (!f.cae) estadoNotion = "❌ Rechazada";

            const props = {
                "Razón Social": { title: [{ text: { content: f.razon_social } }] },
                "CUIT Cliente": { rich_text: [{ text: { content: f.cuit_cliente } }] },
                "Importe":      { number: f.importe },
                "Tipo":         { select: { name: "Factura C" } },
                "Estado":       { select: { name: estadoNotion } },
                "Punto de Venta": { number: 3 },
            };

            if (f.fecha)         props["Fecha Emisión"]  = { date: { start: f.fecha } };
            if (f.periodo_desde) props["Período Desde"]  = { date: { start: f.periodo_desde } };
            if (f.periodo_hasta) props["Período Hasta"]  = { date: { start: f.periodo_hasta } };
            if (f.nro)           props["Nro Comprobante"] = { number: f.nro };
            if (f.cae)           props["CAE"]            = { rich_text: [{ text: { content: f.cae } }] };
            if (f.cae_vto)       props["CAE Vencimiento"] = { date: { start: f.cae_vto } };

            await notion.pages.create({
                parent: { database_id: NOTION_DB_ID },
                properties: props
            });

            console.log(`✅`);
            ok++;
        } catch (e) {
            console.log(`❌ ${e.message}`);
            err++;
        }

        // Respetar rate limit de Notion (3 req/s)
        await sleep(350);
    }

    console.log(`\n🏁 Importación completa: ${ok} OK, ${err} errores.`);
}

main().catch(err => console.error("❌ Fatal:", err.message));
