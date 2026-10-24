const http = require('http');
const { Server } = require('socket.io');
const app = require('./app');
const presence = require('./config/presence');
const notifications = require('./config/notifications');
const rappels = require('./config/rappels');

const PORT = process.env.PORT || 3000;

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  // Coupure brutale (réseau perdu, appareil éteint) détectée en ~15 s au lieu de ~45 s.
  pingInterval: 10000,
  pingTimeout: 5000,
});

presence.initialiser(io);

server.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
  // Notifications push : vérifie la clé Firebase au démarrage, puis rappels de la veille.
  notifications.client();
  rappels.demarrer();
});
