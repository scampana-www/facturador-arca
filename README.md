# Facturador ARCA — Deploy en Railway

Sistema de facturación electrónica para monotributistas.
Corre como daemon en Railway y monitorea Notion para emitir facturas en ARCA.

---

## Arquitectura

```
Notion DB  ──(polling 30s)──▶  daemon.js (Railway)  ──▶  ARCA (WSAA + WSFEV1)
    ▲                                  │
    └──────── actualiza CAE/Estado ────┘
```

**Flujo de trabajo:**
1. Cargás los datos en Notion y ponés Estado = `🚀 Emitir`
2. El daemon lo detecta, llama a ARCA y escribe el CAE en Notion
3. El estado cambia a `✅ Aprobada` (o `❌ Rechazada` con el mensaje de error)

---

## Paso 1 — Preparar el repositorio en GitHub

```bash
git init
git add .
git commit -m "facturador arca railway"
git remote add origin https://github.com/TU_USUARIO/facturador-arca.git
git push -u origin main
```

> ⚠️ Asegurate de agregar `.env` al `.gitignore`. Los certificados NUNCA van al repo.

---

## Paso 2 — Preparar la integración de Notion

1. Ir a **notion.so/my-integrations** → "New integration"
2. Nombre: `Facturador ARCA`
3. Permisos: Read content, Update content, Insert content
4. Copiar el **Internal Integration Token** → `NOTION_TOKEN`
5. Abrir la DB "Registro de Facturas Emitidas" en Notion
6. Click en `...` (arriba derecha) → Connections → agregar `Facturador ARCA`
7. Copiar el **ID de la DB** desde la URL:
   `notion.so/WORKSPACE/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=...`
                         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ este es el ID

---

## Paso 3 — Actualizar el schema de la DB

```bash
npm install
cp .env.example .env
# Editar .env con NOTION_TOKEN y NOTION_DB_ID
node actualizar_db_notion.js
```

---

## Paso 4 — Convertir los certificados a base64

**Windows (PowerShell):**
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("facturador_arca.key")) | clip
# Pegar en CERT_KEY_B64

[Convert]::ToBase64String([IO.File]::ReadAllBytes("facturador_arca.crt")) | clip
# Pegar en CERT_CRT_B64
```

**Linux/Mac:**
```bash
base64 -w 0 facturador_arca.key   # copiar resultado a CERT_KEY_B64
base64 -w 0 facturador_arca.crt   # copiar resultado a CERT_CRT_B64
```

---

## Paso 5 — Importar historial del Excel a Notion (opcional)

Si tenés facturas anteriores en `facturas_RESULTADO.xlsx`:

```bash
node importar_excel_a_notion.js
```

---

## Paso 6 — Deploy en Railway

1. Ir a **railway.app** → New Project → Deploy from GitHub repo
2. Seleccionar tu repositorio
3. Railway detecta el `package.json` y ejecuta `npm start` automáticamente
4. Ir a **Variables** y agregar:

| Variable          | Valor                            |
|-------------------|----------------------------------|
| `NOTION_TOKEN`    | secret_xxx...                    |
| `NOTION_DB_ID`    | ID de la DB (paso 2)             |
| `CUIT_EMISOR`     | 20250886234                      |
| `PUNTO_VENTA`     | 3                                |
| `CERT_KEY_B64`    | (base64 del .key)                |
| `CERT_CRT_B64`    | (base64 del .crt)                |
| `INICIO_ACT`      | 01/07/2019                       |
| `AMBIENTE`        | (vacío = producción)             |
| `POLL_INTERVAL_MS`| 30000                            |

5. Redeploy → el daemon arranca y empieza a monitorear Notion

---

## Uso diario

### Emitir una factura nueva
1. Abrir la DB en Notion
2. Crear un registro con:
   - Razón Social
   - CUIT Cliente
   - Importe
   - Fecha Emisión
   - Período Desde / Hasta
   - Condición IVA / Condición Venta
   - Estado = **`🚀 Emitir`**
3. En hasta 30 segundos el daemon lo procesa y escribe CAE + Nro Comprobante

### Anular una factura
1. En el registro original, cambiar Estado a **`🗑️ Anular`**
2. Verificar que "Nro Factura Original" tenga el número correcto
3. El daemon emite la Nota de Crédito C y actualiza el estado a `🔄 Anulada`

---

## Estructura de archivos

```
facturador-arca/
├── daemon.js                    # Worker principal (entry point Railway)
├── wsaa.js                      # Autenticación ARCA
├── config.js                    # Configuración (lee env vars)
├── lib/
│   ├── emitir.js                # Lógica de emisión de Facturas C
│   └── anular.js                # Lógica de Notas de Crédito C
├── importar_excel_a_notion.js   # Migración inicial del Excel
├── actualizar_db_notion.js      # Setup del schema de Notion
├── package.json
├── .env.example
└── .gitignore
```

---

## Logs en Railway

En Railway → tu servicio → Logs podés ver en tiempo real:

```
═════════════════════════════════════════════════════════════
  Facturador ARCA — Daemon v1.0
  Ambiente  : PRODUCCIÓN ⚠️
  Polling   : cada 30s
═════════════════════════════════════════════════════════════

[14:32:01] 2 registro(s) pendiente(s)
  → Emitiendo: GARCIA MARIO
  ✅ CAE: 74123456789012 | Nro: 12
  → Emitiendo: PEREZ ANA
  ✅ CAE: 74123456789013 | Nro: 13
```
