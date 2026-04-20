/**
 * lib/emitir.js — Emisión de Facturas C leyendo desde Notion
 * ===========================================================
 */
"use strict";

const soap = require("soap");
const wsaa = require("../wsaa");
const cfg  = require("../config");

// Cliente SOAP reutilizable
let _client = null;
async function getClient(produccion) {
    if (!_client) {
        _client = await soap.createClientAsync(produccion ? cfg.WSFE_PROD : cfg.WSFE_TEST);
    }
    return _client;
}

/**
 * Lee las propiedades de una página de Notion y emite la factura en ARCA.
 * @param {object} page  - Página de Notion con sus properties
 * @param {boolean} produccion
 * @returns {{ cae, cae_vto_iso, nro }}
 */
async function procesarPagina(page, produccion) {
    const p = page.properties;

    const factura = {
        fecha:         propFecha(p["Fecha Emisión"]),
        cuit_cliente:  propTexto(p["CUIT Cliente"]).replace(/[^0-9]/g, ""),
        razon_social:  propTitulo(p["Razón Social"]).substring(0, 30),
        importe:       propNumero(p["Importe"]),
        periodo_desde: propFecha(p["Período Desde"]),
        periodo_hasta: propFecha(p["Período Hasta"]),
    };

    // Validaciones mínimas
    if (!factura.cuit_cliente || factura.cuit_cliente.length < 10)
        throw new Error("CUIT inválido o vacío");
    if (!factura.importe || factura.importe <= 0)
        throw new Error("Importe inválido");
    if (!factura.fecha)
        throw new Error("Fecha de emisión requerida");

    const { token, sign } = await wsaa.obtenerToken(produccion);
    const authHeader = { Token: token, Sign: sign, Cuit: Number(cfg.CUIT_EMISOR) };
    const client = await getClient(produccion);

    return await emitirEnArca(client, authHeader, factura);
}

async function emitirEnArca(client, authHeader, f) {
    const authReq = {
        Token: String(authHeader.Token),
        Sign:  String(authHeader.Sign),
        Cuit:  Number(cfg.CUIT_EMISOR)
    };

    const [resUlt] = await client.FECompUltimoAutorizadoAsync({
        Auth:     authReq,
        PtoVta:   Number(cfg.PUNTO_VENTA),
        CbteTipo: Number(cfg.TIPO_FACTURA_C),
    });

    const ultResult = resUlt.FECompUltimoAutorizadoResult || resUlt;
    if (ultResult.Errors?.Err) {
        const e = ultResult.Errors.Err;
        throw new Error(`Error último comprobante: ${Array.isArray(e) ? e[0].Msg : e.Msg}`);
    }

    const nro = Number(ultResult.CbteNro) + 1;

    const fechaCbte = f.fecha.replace(/-/g, "");
    const fDesde    = f.periodo_desde ? f.periodo_desde.replace(/-/g, "") : primerDiaMes(fechaCbte);
    const fHasta    = f.periodo_hasta ? f.periodo_hasta.replace(/-/g, "") : fechaCbte;
    const fVtoPago  = (parseInt(fHasta) < parseInt(fechaCbte)) ? fechaCbte : fHasta;

    const body = {
        Auth: authReq,
        FeCAEReq: {
            FeCabReq: {
                CantReg:  1,
                PtoVta:   Number(cfg.PUNTO_VENTA),
                CbteTipo: Number(cfg.TIPO_FACTURA_C),
            },
            FeDetReq: {
                FECAEDetRequest: [{
                    Concepto:     Number(cfg.CONCEPTO_SERV),
                    DocTipo:      Number(cfg.DOC_TIPO_CUIT),
                    DocNro:       Number(f.cuit_cliente),
                    CbteDesde:    nro,
                    CbteHasta:    nro,
                    CbteFch:      String(fechaCbte),
                    ImpTotal:     Number(f.importe.toFixed(2)),
                    ImpTotConc:   0,
                    ImpNeto:      Number(f.importe.toFixed(2)),
                    ImpOpEx:      0,
                    ImpIVA:       0,
                    ImpTrib:      0,
                    FchServDesde: String(fDesde),
                    FchServHasta: String(fHasta),
                    FchVtoPago:   String(fVtoPago),
                    MonId:        "PES",
                    MonCotiz:     1,
                }]
            },
        },
    };

    const [resp] = await client.FECAESolicitarAsync(body);
    const result = resp.FECAESolicitarResult || resp;

    if (result.Errors?.Err) {
        const e = result.Errors.Err;
        throw new Error(Array.isArray(e) ? e[0].Msg : e.Msg);
    }

    const det  = result.FeDetResp?.FECAEDetResponse;
    const item = Array.isArray(det) ? det[0] : det;
    if (!item) throw new Error("ARCA no devolvió respuesta.");

    if (item.Resultado === "A") {
        const caeVtoStr = String(item.CAEFchVto); // AAAAMMDD
        return {
            ok:          true,
            cae:         item.CAE,
            cae_vto_iso: `${caeVtoStr.slice(0,4)}-${caeVtoStr.slice(4,6)}-${caeVtoStr.slice(6,8)}`,
            nro
        };
    }

    const obs = item.Observaciones?.Obs;
    const msg = obs
        ? (Array.isArray(obs) ? obs : [obs]).map(o => `[${o.Code}] ${o.Msg}`).join("; ")
        : "Rechazado sin observaciones.";
    throw new Error(msg);
}

// ── Helpers para leer propiedades de Notion ──────────────────

function propTitulo(p) {
    return p?.title?.[0]?.plain_text || "";
}
function propTexto(p) {
    return p?.rich_text?.[0]?.plain_text || "";
}
function propNumero(p) {
    return p?.number ?? 0;
}
function propFecha(p) {
    return p?.date?.start || null; // Ya viene como YYYY-MM-DD
}
function primerDiaMes(aaaammdd) {
    return aaaammdd.slice(0, 6) + "01";
}

module.exports = { procesarPagina };
