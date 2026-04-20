/**
 * config.js — Lee configuración desde variables de entorno (Railway)
 * con fallback a los valores hardcodeados para desarrollo local.
 */
module.exports = {
    CUIT_EMISOR:       process.env.CUIT_EMISOR    || "20250886234",
    PUNTO_VENTA:       parseInt(process.env.PUNTO_VENTA || "3"),
    ALIAS:             process.env.CERT_ALIAS      || "facturador_arca",
    INICIO_ACTIVIDADES: process.env.INICIO_ACT    || "01/07/2019",

    WSAA_PROD:  "https://wsaa.afip.gov.ar/ws/services/LoginCms",
    WSAA_TEST:  "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
    WSFE_PROD:  "https://servicios1.afip.gov.ar/wsfev1/service.asmx?WSDL",
    WSFE_TEST:  "https://wswhomo.afip.gov.ar/wsfev1/service.asmx?WSDL",

    TIPO_FACTURA_C: 11,
    CONCEPTO_SERV:   2,
    DOC_TIPO_CUIT:  80,
};
