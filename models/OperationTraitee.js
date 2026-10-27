const mongoose = require('mongoose');

/**
 * Opération déjà traitée (saisie faite hors connexion dans l'espace administrateur, puis
 * renvoyée à la synchronisation) : sa réponse est gardée 60 jours. Si la même opération
 * revient (réseau coupé pendant l'envoi, nouvelle tentative), la réponse enregistrée est
 * renvoyée telle quelle, sans refaire l'action : jamais de doublon.
 */
const operationTraiteeSchema = new mongoose.Schema({
  operationId: { type: String, required: true, unique: true },
  /** « en cours » pendant le traitement (deux envois simultanés), puis « terminée ». */
  statut: { type: String, enum: ['en cours', 'terminée'], default: 'en cours' },
  methode: { type: String, required: true },
  route: { type: String, required: true },
  codeHttp: { type: Number, default: null },
  corps: { type: mongoose.Schema.Types.Mixed, default: null },
  creeLe: { type: Date, default: Date.now, expires: 60 * 24 * 3600 },
});

module.exports = mongoose.model('OperationTraitee', operationTraiteeSchema);
