# Rompecabezas a Dos

Rompecabezas online en tiempo real. Subes una foto, se recorta en cuadrado (1:1), eliges el número de piezas y compartes la sala con un enlace o un código de 5 letras. Todos ven en vivo el cursor y las piezas que mueven los demás.

## Qué incluye

- **Salas**: pública (aparece en la lista del inicio) o privada (solo con código), para 2, 4 u 8 jugadores. Se entra con un enlace (`/?sala=ABCDE`) o escribiendo el código.
- **Piezas fijas**: cuando una pieza o un grupo llega a su lugar dentro del marco, se imanta, suena un clic y ya no se puede mover.
- **Movimiento sin sustos**: arrastrar una pieza nunca mueve la mesa. Un clic en la mesa vacía no hace nada. Para mover la mesa: clic derecho, barra espaciadora, dos dedos, o el botón *Mover mesa*. La rueda del ratón hace zoom.
- **Selección tolerante**: si el clic cae justo al lado del borde de una pieza, igual la toma.
- **Ayudas**: *Ordenar* acomoda las piezas sueltas alrededor del marco (bordes primero); *Bordes* resalta solo las piezas de la orilla; *Guía* muestra la foto tenue en el marco; *Foto* muestra la original.
- **Sin choques**: mientras alguien sostiene una pieza, nadie más puede tomarla. El servidor decide cómo encaja cada pieza, así los jugadores nunca se pisan los cambios.
- Chat de la sala, contador de piezas colocadas y tiempo, confeti al terminar, pantalla completa, y el progreso se guarda en el servidor.

## Probarlo en tu computadora

Necesitas [Node.js](https://nodejs.org) 18 o más reciente.

```bash
npm install
npm start
```

Abre <http://localhost:3000>. Para jugar con alguien en tu misma red wifi, que abra `http://TU-IP-LOCAL:3000` (por ejemplo `http://192.168.1.20:3000`).

Prueba automática (crea una sala, conecta dos jugadores y arma un 3x3):

```bash
npm test
```

## Publicarlo en internet

La app es un solo servidor Node (web + WebSocket). Cualquier servicio que corra Node o Docker sirve. Guarda las salas y fotos en la carpeta `DATA_DIR`: **usa un disco persistente** o se borrarán al reiniciar el servidor.

### Opción A: Render (la más fácil)

1. Sube esta carpeta a un repositorio de GitHub.
2. En [render.com](https://render.com): **New → Blueprint** y elige el repositorio. Render lee `render.yaml` y crea el servicio con un disco de 1 GB.
3. Al terminar te da una dirección tipo `https://rompecabezas-a-dos.onrender.com`. Esa es tu página.

El plan gratis de Render funciona, pero no tiene disco (las salas se pierden al reiniciar) y el servidor se duerme tras 15 min sin visitas. El plan *Starter* con disco evita las dos cosas.

### Opción B: Railway

1. **New Project → Deploy from GitHub repo**.
2. En el servicio: **Settings → Volumes → Add volume** montado en `/data`.
3. En **Variables** agrega `DATA_DIR=/data`.
4. En **Settings → Networking → Generate domain** para obtener tu dirección pública.

### Opción C: Tu propio servidor (VPS) con Docker

```bash
docker build -t rompecabezas .
docker run -d --name rompecabezas --restart unless-stopped -p 3000:3000 -v rompecabezas-datos:/data rompecabezas
```

Pon Nginx delante con HTTPS (por ejemplo con Certbot). Lo importante es dejar pasar el WebSocket:

```nginx
server {
    server_name tudominio.com;
    client_max_body_size 6m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }
}
```

Sin Docker también funciona: `npm install --omit=dev` y `npm start`, idealmente con `pm2` para que se reinicie solo.

## Configuración

| Variable        | Por defecto   | Para qué sirve                                         |
|-----------------|---------------|--------------------------------------------------------|
| `PORT`          | `3000`        | Puerto del servidor.                                   |
| `DATA_DIR`      | `./data`      | Carpeta donde se guardan salas (`rooms/`) y fotos (`images/`). |
| `ROOM_TTL_DAYS` | `30`          | Días sin actividad antes de borrar una sala.           |
| `MAX_ROOMS`     | `500`         | Máximo de salas guardadas a la vez.                    |

Límites incluidos: fotos de hasta 3 MB (el navegador las reduce a 1024×1024 antes de subirlas), 20 salas o fotos nuevas por hora por IP, y 60 mensajes de chat por sala.

## Estructura

```
server/index.js    Servidor HTTP + WebSocket, salas, guardado en disco
server/puzzle.js   Reglas del juego: posiciones, encaje, piezas fijas, ordenar
public/index.html  Inicio (salas) y mesa de juego
public/css/        Estilos
public/js/main.js      Pantallas, salas, chat, subir foto
public/js/game.js      Mesa: dibujo, controles, sincronización
public/js/geometry.js  Forma de las piezas (igual para todos a partir de una semilla)
public/js/cropper.js   Recorte cuadrado de la foto
public/js/net.js       Conexión con reconexión automática
test/smoke.js      Prueba de extremo a extremo
```

## Cómo funciona el encaje

La mesa mide 3×2 unidades y el rompecabezas completo 1×1, con el marco en el centro. Cada grupo de piezas guarda dónde quedaría la esquina de la foto completa. Dos grupos encajan cuando esas esquinas casi coinciden y tienen piezas vecinas. Si esa esquina queda cerca de la del marco, el grupo está en su lugar correcto: se coloca exacto y queda fijo.
