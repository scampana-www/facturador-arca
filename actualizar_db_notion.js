"use strict";
require("dotenv").config();
const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID  = process.env.NOTION_DB_ID;

async function main() {
    console.log("🔧 Actualizando schema de la DB en Notion...");

    await notion.databases.update({
        database_id: DB_ID,
        properties: {
            "Domicilio": { rich_text: {} },
            "Condición IVA": {
                select: { options: [
                    { name: "Consumidor Final",      color: "gray"   },
                    { name: "Responsable Inscripto", color: "blue"   },
                    { name: "Exento",                color: "green"  },
                    { name: "Monotributista",        color: "yellow" },
                ]}
            },
            "Condición Venta": {
                select: { options: [
                    { name: "Contado",       color: "green"  },
                    { name: "Transferencia", color: "blue"   },
                    { name: "Cuenta Cte",    color: "orange" },
                ]}
            },
            "Error": { rich_text: {} },
        }
    });

    // Agregar opciones nuevas al Estado por separado
    const db = await notion.databases.retrieve({ database_id: DB_ID });
    const opcionesActuales = db.properties["Estado"].select.options.map(o => o.name);
    const nuevas = ["🚀 Emitir", "🗑️ Anular", "⏳ Procesando"];
    const agregar = nuevas.filter(n => !opcionesActuales.includes(n));

    if (agregar.length > 0) {
        const colores = { "🚀 Emitir": "blue", "🗑️ Anular": "orange", "⏳ Procesando": "yellow" };
        const todasOpciones = [
            ...db.properties["Estado"].select.options,
            ...agregar.map(n => ({ name: n, color: colores[n] }))
        ];
        await notion.databases.update({
            database_id: DB_ID,
            properties: {
                "Estado": { select: { options: todasOpciones } }
            }
        });
        console.log(`  + Opciones agregadas a Estado: ${agregar.join(", ")}`);
    } else {
        console.log("  ✓ Estado ya tiene todas las opciones.");
    }

    console.log("✅ Schema actualizado correctamente.");
}

main().catch(err => console.error("❌ Error:", err.message));