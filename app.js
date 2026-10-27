// Messages d'erreur en français : avant tout modèle Mongoose (voir config/erreursFr.js).
const erreursFr = require('./config/erreursFr');
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

// Urgences, flotte d'ambulances et application chauffeur
app.use('/api/urgences', require('./routes/urgences'));
app.use('/api/flotte', require('./routes/flotte'));
app.use('/api/chauffeur', require('./routes/chauffeur'));

// Espace patiente (application mobile)
app.use('/api/espace-patiente', require('./routes/espacePatiente'));

// Route inconnue : réponse JSON (sans détail technique).
app.use('/api', (req, res) => {
  res.status(404).json({ message: 'Ressource introuvable.' });
});

/** Erreurs HTTP génériques des bibliothèques (http-errors) : message anglais remplacé. */
const MESSAGES_HTTP = {
  400: 'Requête invalide.', 401: 'Authentification requise.', 403: 'Accès refusé.', 404: 'Ressource introuvable.',
  405: 'Action non autorisée.', 408: 'Délai dépassé, réessayez.', 413: 'Données envoyées trop volumineuses.',
  415: 'Format des données non pris en charge.', 429: 'Trop de requêtes, patientez un instant.',
};

// Express 5 transmet aussi les erreurs des fonctions async. Toute réponse d'erreur est en français.
app.use((err, req, res, next) => {
  const traduite = erreursFr.traduire(err);
  if (traduite) return res.status(traduite.status).json({ message: traduite.message });
  // Erreur d'une bibliothèque (http-errors, « expose ») : message générique en français.
  if (err.status && err.expose) return res.status(err.status).json({ message: MESSAGES_HTTP[err.status] ?? 'Requête invalide.' });
  // details : informations destinées au formulaire (ex. éléments manquants), jamais de trace technique.
  if (err.status && err.status < 500) return res.status(err.status).json({ message: err.message, ...err.details });
  console.error(err);
  res.status(err.status >= 500 ? err.status : 500).json({ message: 'Erreur interne du serveur.' });
});

module.exports = app;
