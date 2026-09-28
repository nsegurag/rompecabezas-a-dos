# Rompecabezas a Dos

Rompecabezas online en tiempo real. Subes una foto, eliges su forma y cuántas piezas, decides cómo jugar y compartes la sala con un enlace o un código de 5 letras. Mientras arman pueden hablar por voz o con cámara.

## Qué incluye

**Modos de juego**
- **Clásico**: todos arman el mismo rompecabezas, sin reloj.
- **Contrarreloj**: todos juntos contra el tiempo (de 3 a 60 minutos). Si se acaba, pueden seguir sin límite, reintentar o empezar otra partida.
- **Carrera**: cada quien arma su propia copia. Hay cuenta regresiva, un panel con el avance de todos y, al terminar, puedes mirar el tablero de los demás. Resultados con medallas y botón de **Revancha**.

**Fotos y piezas**
- Formas **cuadrada, 4:3, 3:4, 16:9 y 9:16**, con la más adecuada recomendada según tu foto.
- De **16 a unas 500 piezas**. Las piezas siempre salen casi cuadradas; el número exacto depende de la forma (por ejemplo, 494 en 16:9).
- En una sala se puede empezar otra partida con **la misma foto** (se revuelve de nuevo) o con una nueva.

**Juntos**
- **Llamada con voz y cámara** dentro del juego, hasta 6 personas: silenciar el micrófono, apagar la cámara, cambiar a la cámara trasera en el celular. Un borde verde muestra quién habla.
- **Video del armado**: al terminar (o cuando quieras) se genera un video en cámara rápida de 10 a 25 segundos para descargar o compartir. Se crea en tu propio dispositivo.
- Cursores y piezas de los demás en vivo; nadie puede tomar una pieza que otro sostiene.
- Puntos por jugador con podio, reacciones con emojis que flotan sobre la mesa (personalizables, teclas 1 a 5) y chat.

**Cómodo en PC, tablet y celular**
- Asistente de 3 pasos para crear la sala: **Foto → Juego → Sala**.
- En celular: barra superior compacta, menú que sube desde abajo, paneles tipo hoja, la vista se centra en el marco y viene activada la **bandeja** con las piezas sin mover (se sacan arrastrándolas hacia arriba).
- Arrastrar una pieza nunca mueve la mesa. Para mover la mesa: clic derecho, barra espaciadora, dos dedos o el botón *Mover*.
- Las piezas que llegan a su lugar se imantan, suenan y quedan fijas. Las piezas unidas se ven como una sola foto.
- Ayudas: *Ordenar* (bordes primero), *Bordes*, *Guía*, *Foto* y 5 fondos de mesa.
- Se puede **instalar como app** (Android, iPhone, PC).

**Administrar la sala** (toca los jugadores en la barra superior)
- Quien crea la sala es el **dueño**: puede nombrar administradores y pasar la sala a otra persona.
- Dueño y admins pueden dejar a alguien **solo mirando**, **silenciarlo** (chat y llamada), **sacarlo** o **bloquearlo**.
- Ajustes: nombre, pública o privada, máximo de jugadores (2, 4, 8 o 12), contraseña, quién puede empezar otra partida y quién puede usar *Ordenar*. El dueño puede cerrar la sala.
- Iniciar la partida (Contrarreloj y Carrera), reintentar o pedir revancha: lo hacen los admins, o cualquiera si no hay un admin conectado.

## Probarlo en tu computadora

Necesitas [Node.js](https://nodejs.org) 18 o más reciente.

```bash
npm install
npm start
```

Abre <http://localhost:3000>. Para jugar con alguien en tu misma red wifi, que abra `http://TU-IP-LOCAL:3000`. La llamada con cámara necesita `https://` (o `localhost`), así que en la red local solo funciona desde la computadora que corre el servidor; ya publicado en internet funciona para todos.

Pruebas automáticas (salas, encajes, los tres modos, administración, llamada y video):

```bash
npm test
```

## Publicarlo en internet

La app es un solo servidor Node (web + WebSocket). Guarda salas y fotos en la carpeta `DATA_DIR`: **usa un disco persistente** o se borrarán al reiniciar el servidor.

### Render

1. Sube todo el contenido de esta carpeta a tu repositorio de GitHub (incluidas `server`, `public` y `test`).
2. Si ya tienes el servicio creado, Render publica solo cada vez que subes cambios a GitHub.
3. Si es nuevo: **New → Web Service**, elige el repositorio. Render detecta el `Dockerfile` y lo usa.
4. Para que las salas no se borren: plan *Starter* + **Disks → Add Disk** con *Mount Path* `/data` (con Docker los datos ya se guardan ahí). Si usas el runtime de Node en vez de Docker, pon el disco en `/var/data` y la variable `DATA_DIR=/var/data`.

### Railway, VPS o cualquier servidor con Docker

```bash
docker build -t rompecabezas .
docker run -d --name rompecabezas --restart unless-stopped -p 3000:3000 -v rompecabezas-datos:/data rompecabezas
```

Con Nginx delante hay que dejar pasar el WebSocket y fotos de hasta ~9 MB:

```nginx
server {
    server_name tudominio.com;
    client_max_body_size 10m;
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

## Llamada: servidor TURN (recomendado)

La voz y el video viajan directo entre los jugadores. En la mayoría de las redes eso funciona solo, pero en algunas (datos móviles de ciertas compañías, redes de empresas o universidades) la conexión directa no se logra y la llamada se queda en "conectando…". Para esos casos se usa un **servidor TURN** que hace de puente.

Hay servicios con plan gratis (por ejemplo Metered o Cloudflare Calls/TURN). Cuando tengas los datos, agrega estas variables de entorno en Render:

| Variable          | Ejemplo                                                             |
|-------------------|---------------------------------------------------------------------|
| `TURN_URLS`       | `turn:global.relay.metered.ca:80,turns:global.relay.metered.ca:443` |
| `TURN_USERNAME`   | el usuario que te da el servicio                                    |
| `TURN_CREDENTIAL` | la contraseña que te da el servicio                                 |

Sin TURN la llamada funciona igual en la mayoría de los casos; solo falla en esas redes restrictivas.

## Configuración

| Variable        | Por defecto | Para qué sirve                                                  |
|-----------------|-------------|-----------------------------------------------------------------|
| `PORT`          | `3000`      | Puerto del servidor.                                            |
| `DATA_DIR`      | `./data`    | Carpeta donde se guardan salas (`rooms/`) y fotos (`images/`).  |
| `ROOM_TTL_DAYS` | `30`        | Días sin actividad antes de borrar una sala.                    |
| `MAX_ROOMS`     | `500`       | Máximo de salas guardadas a la vez.                             |
| `TURN_*`        | (vacío)     | Servidor TURN para la llamada (ver arriba).                     |
| `RZ_MINUTE_MS`  | `60000`     | Solo para pruebas: acorta los minutos del Contrarreloj.         |

Límites incluidos: fotos de hasta 6 MB (el navegador las reduce antes de subirlas), 30 salas o fotos nuevas por hora por IP, llamada de hasta 6 personas y 60 mensajes de chat por sala.

## Estructura

```
server/index.js      Servidor: salas, modos de juego, administración, señalización de la llamada, guardado
server/puzzle.js     Reglas: tamaño de piezas, posiciones, encajes, piezas fijas, ordenar
public/index.html    Inicio (salas) y mesa de juego
public/css/          Estilos (celular, tablet y PC)
public/js/main.js        Pantallas, asistente, carrera, llamada, video, paneles
public/js/game.js        Mesa: dibujo, controles, sincronización
public/js/geometry.js    Forma de las piezas (igual para todos a partir de una semilla)
public/js/rtc.js         Llamada de voz y video (WebRTC)
public/js/timelapse.js   Video del armado en cámara rápida
public/js/cropper.js     Recorte de la foto
public/js/net.js         Conexión con reconexión automática
public/sw.js, manifest.webmanifest, icons/   App instalable
test/smoke.js        Pruebas de extremo a extremo
```

Las salas creadas con versiones anteriores siguen funcionando: se convierten solas al abrirlas.

## Cómo funciona el encaje

La mesa mide 3×2 unidades y el rompecabezas completo cabe en el marco del centro (su tamaño depende de la forma de la foto). Cada grupo de piezas guarda dónde quedaría la esquina de la foto completa. Dos grupos encajan cuando esas esquinas casi coinciden y tienen piezas vecinas. Si esa esquina queda cerca de la del marco, el grupo está en su lugar: se coloca exacto y queda fijo.
