# Guía de despliegue — Servidor de Licencias LamineResell v2

## Lo que tienes ahora

| Componente | Descripción |
|---|---|
| `server/server.js` | API Node.js con JWT, bcrypt, rate limiting, device tracking, audit log |
| `background.js` | Verificación de licencia + deviceId + validación de acciones críticas |
| `login.html/js` | Página de login/registro de la extensión |
| `build/build.js` | Script de ofuscación del código de la extensión |

---

## 1. Instalar y arrancar el servidor

```bash
cd server
npm install
cp .env.example .env
# Edita .env con tus secretos (ver sección 3)
npm start
```

Prueba:
```bash
curl http://localhost:3000/health
# → { "ok": true, "ts": "...", "version": "2.0.0" }
```

---

## 2. Despliegue en Railway (recomendado — gratis)

1. Sube la carpeta `server/` a GitHub
2. Railway → **New Project** → **Deploy from GitHub**
3. En **Variables** añade (ver sección 3):
   - `JWT_SECRET`, `ADMIN_SECRET`, `DB_PATH=/data/licenses.db`
4. En **Volumes** → Add Volume → mount path `/data` (para que la BD persista)
5. Railway te da una URL: `https://tu-proyecto.up.railway.app`

---

## 3. Variables de entorno (`.env`)

```env
PORT=3000

# Genera con: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=SECRETO_ALEATORIO_MUY_LARGO_64_CHARS_MINIMO

# Cadena larga y única para acceso admin inicial
ADMIN_SECRET=OTRO_SECRETO_SEGURO

JWT_EXPIRES_IN=30d
DB_PATH=./licenses.db

# Límites de seguridad (opcional)
MAX_IPS_24H=6       # IPs únicas en 24h antes de flagear usuario
MAX_DEVICES=5       # Dispositivos únicos antes de flagear
NODE_ENV=production
```

> ⚠️ **Nunca** subas `.env` a Git.

---

## 4. Configurar la extensión con tu URL

Cambia `TU_SERVIDOR.com` en **4 archivos**:

```bash
# Busca y reemplaza en todos:
grep -r "TU_SERVIDOR.com" . --include="*.js" --include="*.json" -l
```

Los archivos son:
- `background.js` línea 39
- `login.js` línea 2
- `modules/licensing/licenseManager.js` línea 3
- `manifest.json` línea 17

---

## 5. Flujo completo de acceso

```
1. Usuario instala la extensión
2. Abre el popup → overlay de login aparece
3. Clic en "Iniciar sesión" → se abre login.html
4. Se registra → POST /auth/register → licencia queda "inactive"
5. Tú (admin) activas su licencia → POST /admin/license/activate
6. Usuario abre popup → acceso concedido
7. Cada 10 min, la extensión re-verifica la licencia automáticamente
8. Antes de acciones críticas, la extensión llama POST /action/validate
```

---

## 6. Gestión de usuarios (comandos)

Reemplaza `URL` y `ADMIN_SECRET` por los tuyos.

### Ver todos los usuarios
```bash
curl https://URL/admin/users -H "x-admin-secret: ADMIN_SECRET"
```

### Activar licencia
```bash
curl -X POST https://URL/admin/license/activate \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: ADMIN_SECRET" \
  -d '{"email": "usuario@email.com", "plan": "standard"}'
```

### Con fecha de expiración
```bash
curl -X POST https://URL/admin/license/activate \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: ADMIN_SECRET" \
  -d '{"email": "usuario@email.com", "expiresAt": "2027-01-01T00:00:00Z"}'
```

### Revocar licencia
```bash
curl -X POST https://URL/admin/license/revoke \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: ADMIN_SECRET" \
  -d '{"email": "usuario@email.com", "notes": "impago"}'
```

### Ver logs de acciones (últimas 100)
```bash
curl https://URL/admin/logs -H "x-admin-secret: ADMIN_SECRET"
```

### Ver dispositivos de un usuario
```bash
curl https://URL/admin/users/1/devices -H "x-admin-secret: ADMIN_SECRET"
```

### Limpiar flag de dispositivo sospechoso
```bash
curl -X POST https://URL/admin/devices/unflag \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: ADMIN_SECRET" \
  -d '{"userId": 1}'
```

### Dar acceso admin a un usuario (para usar JWT en lugar de ADMIN_SECRET)
```bash
curl -X POST https://URL/admin/users/set-admin \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: ADMIN_SECRET" \
  -d '{"email": "tu@email.com"}'
```

---

## 7. Ofuscación del código de la extensión

El código ofuscado va en `dist/` y es el que distribuyes a tus usuarios.

```bash
# Instalar herramienta de ofuscación (solo la primera vez)
npm install --save-dev javascript-obfuscator

# Generar dist/ ofuscado
npm run build
```

Resultado:
```
[build] ✓ background.js  (245KB → 680KB)
[build] ✓ popup.js       (18KB → 52KB)
[build] ✓ marketplace.js (38KB → 110KB)
...
[build] Para cargar en Chrome: chrome://extensions → "Cargar descomprimida" → selecciona dist/
```

**Cada vez que hagas cambios**, vuelve a correr `npm run build` y distribuye el nuevo `dist/`.

---

## 8. Endpoints de la API

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| GET | `/health` | — | Estado del servidor |
| POST | `/auth/register` | — | Crear cuenta |
| POST | `/auth/login` | — | Login → JWT |
| GET | `/auth/me` | JWT | Info del usuario |
| GET | `/license/verify` | JWT + X-Device-Id | Verificar licencia (la extensión) |
| POST | `/action/validate` | JWT + X-Device-Id | Pedir permiso para acción crítica |
| GET | `/admin/users` | Admin | Listar usuarios |
| GET | `/admin/users/:id/devices` | Admin | Dispositivos de un usuario |
| GET | `/admin/logs` | Admin | Audit log de acciones |
| POST | `/admin/license/activate` | Admin | Activar licencia |
| POST | `/admin/license/revoke` | Admin | Revocar licencia |
| POST | `/admin/users/set-admin` | Admin | Dar rol admin |
| POST | `/admin/devices/unflag` | Admin | Limpiar flag sospechoso |
| DELETE | `/admin/users/:email` | Admin | Eliminar usuario |

---

## 9. Seguridad implementada

| Mecanismo | Descripción |
|---|---|
| JWT (30 días) | Token firmado con HS256, imposible de falsificar sin el secret |
| bcrypt (12 rounds) | Contraseñas hasheadas, imposible de recuperar aunque roben la BD |
| Rate limiting | Auth: 10/15min · Acciones: 60/min · Admin: 50/15min · General: 200/15min |
| Helmet | 14 cabeceras de seguridad HTTP automáticas |
| Timing-safe compare | El login no revela si el email existe (mismo tiempo de respuesta) |
| Device tracking | Registra deviceId + IP por usuario, detecta cambios sospechosos |
| Audit log | Cada `/license/verify` y `/action/validate` queda registrado |
| Backend authority | Las acciones críticas se validan en el servidor, no en la extensión |
| Re-verificación | La extensión revalida la licencia cada 10 minutos automáticamente |
| Input sanitization | Todos los inputs se recortan y limitan en longitud |
| Body limit | Requests de más de 10KB son rechazadas |
| CORS restringido | Solo acepta peticiones desde extensiones Chrome y localhost |

---

## 10. Problemas comunes

**"No se pudo conectar al servidor"**
→ Comprueba `AUTH_API_URL` en `background.js` y `login.js`.
→ Verifica que el dominio está en `host_permissions` del `manifest.json`.
→ El servidor debe responder en `/health`.

**"token_invalid_or_expired"**
→ El JWT expiró. El usuario debe hacer logout y login de nuevo.
→ Para extender el tiempo: cambia `JWT_EXPIRES_IN=90d` en `.env`.

**"too_many_auth_attempts"**
→ Rate limiting activado. El usuario tiene que esperar 15 minutos.

**La base de datos se borra en Railway**
→ Falta el Volume. Añade un Volume en Railway con mount path `/data` y pon `DB_PATH=/data/licenses.db`.

**El overlay de login siempre aparece**
→ Asegúrate de que `AUTH_API_URL` apunta a tu servidor real y que el servidor está corriendo.
