/**
 * wsaa.js — Autenticación WSAA de ARCA
 * ======================================
 * En Railway los certificados se cargan desde variables de entorno en base64:
 *   CERT_KEY_B64  → contenido del .key en base64
 *   CERT_CRT_B64  → contenido del .crt en base64
 *
 * Para convertir localmente:
 *   PowerShell: [Convert]::ToBase64String([IO.File]::ReadAllBytes("facturador_arca.key"))
 *   Linux/Mac:  base64 -w 0 facturador_arca.key
 */

const forge  = require("node-forge");
const axios  = require("axios");
const xml2js = require("xml2js");
const fs     = require("fs");
const path   = require("path");
const cfg    = require("./config");

let tokenCache = { token: null, sign: null, expiracion: null };

async function obtenerToken(produccion = true) {
    const ahora = new Date();

    if (tokenCache.token && tokenCache.expiracion && ahora < tokenCache.expiracion) {
        return { token: tokenCache.token, sign: tokenCache.sign };
    }

    console.log("  🔐 Autenticando en WSAA de ARCA...");

    // ── Cargar certificados: primero desde env vars (Railway), luego desde disco (local) ──
    let privateKeyPem, certPem;

    if (process.env.CERT_KEY_B64 && process.env.CERT_CRT_B64) {
        privateKeyPem = Buffer.from(process.env.CERT_KEY_B64, "base64").toString("utf8");
        certPem       = Buffer.from(process.env.CERT_CRT_B64, "base64").toString("utf8");
    } else {
        const keyFile  = path.join(__dirname, `${cfg.ALIAS}.key`);
        const certFile = path.join(__dirname, `${cfg.ALIAS}.crt`);
        if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
            throw new Error("Faltan archivos .key/.crt en disco y no hay variables CERT_KEY_B64/CERT_CRT_B64.");
        }
        privateKeyPem = fs.readFileSync(keyFile, "utf8");
        certPem       = fs.readFileSync(certFile, "utf8");
    }

    const desde    = new Date(ahora.getTime() - 10 * 60 * 1000);
    const hasta    = new Date(ahora.getTime() + 12 * 60 * 60 * 1000);
    const uniqueId = Math.floor(Date.now() / 1000).toString();

    const tra = `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${uniqueId}</uniqueId>
    <generationTime>${formatFechaISO(desde)}</generationTime>
    <expirationTime>${formatFechaISO(hasta)}</expirationTime>
  </header>
  <service>wsfe</service>
</loginTicketRequest>`;

    const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
    const cert       = forge.pki.certificateFromPem(certPem);

    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(tra, "utf8");
    p7.addCertificate(cert);
    p7.addSigner({
        key: privateKey,
        certificate: cert,
        digestAlgorithm: forge.pki.oids.sha256,
        authenticatedAttributes: [
            { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
            { type: forge.pki.oids.messageDigest },
            { type: forge.pki.oids.signingTime, value: new Date() }
        ]
    });

    p7.sign({ detached: false });

    const cmsDer    = forge.asn1.toDer(p7.toAsn1()).getBytes();
    const cmsBase64 = forge.util.encode64(cmsDer);

    const urlWsaa  = produccion ? cfg.WSAA_PROD : cfg.WSAA_TEST;
    const soapBody = `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
    <SOAP-ENV:Body>
      <loginCms xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov.ar">
        <in0>${cmsBase64}</in0>
      </loginCms>
    </SOAP-ENV:Body>
  </SOAP-ENV:Envelope>`;

    let resp;
    try {
        resp = await axios.post(urlWsaa, soapBody, {
            headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "" },
            timeout: 30000
        });
    } catch (error) {
        if (error.response) console.error("\n❌ ERROR ARCA:", error.response.data);
        throw error;
    }

    const parsed   = await xml2js.parseStringPromise(resp.data, { explicitArray: false });
    const envelope = parsed["SOAP-ENV:Envelope"] || parsed["soapenv:Envelope"] || parsed["soap:Envelope"];
    const body     = envelope
        ? (envelope["SOAP-ENV:Body"] || envelope["soapenv:Body"] || envelope["soap:Body"])
        : null;

    if (!body) throw new Error("No se encontró el Body en la respuesta WSAA");

    const fault = body["SOAP-ENV:Fault"] || body["soapenv:Fault"];
    if (fault) throw new Error(`Falla WSAA: ${fault.faultstring}`);

    const retKey  = Object.keys(body).find(k => k.includes("loginCmsReturn") || k.includes("Response"));
    const taXml   = body[retKey]?.["loginCmsReturn"] || body[retKey];
    const taParsed = await xml2js.parseStringPromise(taXml, { explicitArray: false });
    const credentials = taParsed["loginTicketResponse"]["credentials"];

    tokenCache = {
        token:      credentials["token"],
        sign:       credentials["sign"],
        expiracion: new Date(taParsed["loginTicketResponse"]["header"]["expirationTime"])
    };

    console.log("  ✅ Token obtenido con éxito.");
    return { token: tokenCache.token, sign: tokenCache.sign };
}

function formatFechaISO(date) {
    const pad = n => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}-03:00`;
}

module.exports = { obtenerToken };
