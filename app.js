const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { identifierRequete } = require('./middleware/clinique');

process.loadEnvFile();

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log('Connexion à MongoDB réussie'))
  .catch((err) => console.error('Connexion à MongoDB échouée :', err.message));

const app = express();

app.use(cors({ exposedHeaders: ['X-Request-Id'] }));
app.use(identifierRequete);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.json({ message: 'API ami-connecte opérationnelle' });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/soignants', require('./routes/soignants'));
app.use('/api/etablissements', require('./routes/etablissements'));

// Suivi prénatal (CPN)
const suivi = require('./routes/suivi');
app.use('/api/patientes', require('./routes/patientes'));
app.use('/api/referentiels', require('./routes/referentiels'));
app.use('/api/statistiques', require('./routes/statistiques'));
app.use('/api/discussions', require('./routes/discussions'));
app.use('/api/articles', require('./routes/articles'));
app.use('/api/grossesses', suivi.grossesses);
app.use('/api/consultations', suivi.consultations);
app.use('/api/rendez-vous', suivi.rendezVous);
app.use('/api/journal', suivi.journal);

// Accouchement, nouveau-né et suivi de l'enfant (vaccination)
app.use('/api/accouchements', require('./routes/accouchements'));
app.use('/api/enfants', require('./routes/enfants'));

// Espace patiente (application mobile)
app.use('/api/espace-patiente', require('./routes/espacePatiente'));

// Route inconnue : réponse JSON (sans détail technique).
app.use('/api', (req, res) => {
  res.status(404).json({ message: 'Ressource introuvable.' });
});

// Express 5 transmet aussi les erreurs des fonctions async.
app.use((err, req, res, next) => {
  // details : informations destinées au formulaire (ex. éléments manquants), jamais de trace technique.
  if (err.status) return res.status(err.status).json({ message: err.message, ...err.details });
  console.error(err);
  res.status(500).json({ message: 'Erreur interne du serveur.' });
});

module.exports = app;
