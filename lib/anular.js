/**
 * lib/anular.js — Emisión de Notas de Crédito C leyendo desde Notion
 * ===================================================================
 */
"use strict";

const soap = require("soap");
const wsaa = require("../wsaa");
const cfg  = require("../config");

let _client = null;
async function getClient(produccion) {
    if (!_client) {
        _client = await soap.createClientAsync(produccion ? cfg.WSFE_PROD : cfg.WSFE_TEST);
    }
    return _client;
}

/**
 * Lee las propiedades de una página de Notion y emite la NC en ARCA.
 */
async function procesarPagina(page, produccion) {
    const p = page.properties;

    const datos = {
        cuit_cliente:       propTexto(p["CUIT Cliente"]).replace(/[^0-9]/g, ""),
        razon_social:       propTitulo(p["Razón Social"]),
        importe:            propNumero(p["Importe"]),
        nro_factura_orig:   propNumero(p["Nro Factura Original"]),
        domicilio:          propTexto(p["Domicilio"]) || "",
        cond_iva:           propSelect(p["Condición IVA"]) || "Consumidor Final",
        cond_venta:         propSelect(p["Condición Venta"]) || "Contado",
    };

    if (!datos.cuit_cliente || datos.cuit_cliente.length < 10)
        throw new Error("CUIT inválido");
    if (!datos.importe || datos.importe <= 0)
        throw new Error("Importe inválido");
    if (!datos.nro_factura_orig)
        throw new Error("Nro Factura Original requerido para anular");

    const { token, sign } = await wsaa.obtenerToken(produccion);
    const authHeader = { Token: token, Sign: sign, Cuit: Number(cfg.CUIT_EMISOR) };
    const client = await getClient(produccion);

    return await emitirNCEnArca(client, authHeader, datos);
}

async function emitirNCEnArca(client, authHeader, datos) {
    const authReq = {
        Token: String(authHeader.Token),
        Sign:  String(authHeader.Sign),
        Cuit:  Number(cfg.CUIT_EMISOR)
    };

    const [resUlt] = await client.FECompUltimoAutorizadoAsync({
        Auth:     authReq,
        PtoVta:   Number(cfg.PUNTO_VENTA),
        CbteTipo: 13, // Nota de Crédito C
    });

    const ultResult = resUlt.FECompUltimoAutorizadoResult || resUlt;
    if (ultResult.Errors?.Err) {
        const e = ultResult.Errors.Err;
        throw new Error(`Error último comprobante: ${Array.isArray(e) ? e[0].Msg : e.Msg}`);
    }

    const nroNC = Number(ultResult.CbteNro) + 1;

    const hoy = getFechaHoy();

    const body = {
        Auth: authReq,
        FeCAEReq: {
            FeCabReq: {
                CantReg:  1,
                PtoVta:   Number(cfg.PUNTO_VENTA),
                CbteTipo: 13,
            },
            FeDetReq: {
                FECAEDetRequest: [{
                    Concepto:     Number(cfg.CONCEPTO_SERV),
                    DocTipo:      80,
                    DocNro:       Number(datos.cuit_cliente),
                    CbteDesde:    nroNC,
                    CbteHasta:    nroNC,
                    CbteFch:      hoy,
                    ImpTotal:     Number(datos.importe.toFixed(2)),
                    ImpTotConc:   0,
                    ImpNeto:      Number(datos.importe.toFixed(2)),
                    ImpOpEx:      0,
                    ImpIVA:       0,
                    ImpTrib:      0,
                    FchServDesde: hoy,
                    FchServHasta: hoy,
                    FchVtoPago:   hoy,
                    MonId:        "PES",
                    MonCotiz:     1,
                    CbtesAsoc: {
                        CbteAsoc: [{
                            Tipo:   Number(cfg.TIPO_FACTURA_C),
                            PtoVta: Number(cfg.PUNTO_VENTA),
                            Nro:    Number(datos.nro_factura_orig)
                        }]
                    }
                }]
            }
        }
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
        const caeVtoStr = String(item.CAEFchVto);
        return {
            ok:          true,
            cae:         item.CAE,
            cae_vto_iso: `${caeVtoStr.slice(0,4)}-${caeVtoStr.slice(4,6)}-${caeVtoStr.slice(6,8)}`,
            nro:         nroNC
        };
    }

    const obs = item.Observaciones?.Obs;
    const msg = obs
        ? (Array.isArray(obs) ? obs : [obs]).map(o => `[${o.Code}] ${o.Msg}`).join("; ")
        : "Rechazada sin observaciones.";
    throw new Error(msg);
}

function getFechaHoy() {
    const hoy = new Date();
    return `${hoy.getFullYear()}${String(hoy.getMonth()+1).padStart(2,"0")}${String(hoy.getDate()).padStart(2,"0")}`;
}

function propTitulo(p) { return p?.title?.[0]?.plain_text || ""; }
function propTexto(p)  { return p?.rich_text?.[0]?.plain_text || ""; }
function propNumero(p) { return p?.number ?? 0; }
function propSelect(p) { return p?.select?.name || null; }

module.exports = { procesarPagina };
