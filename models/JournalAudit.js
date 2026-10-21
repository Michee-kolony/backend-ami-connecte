const mongoose = require('mongoose');
const { auteurSchema, versJson } = require('./commun');

/**
 * Journal d'audit, séparé des données cliniques et en ajout seul : qui a fait quoi, sur quelle
 * patiente, quand, avec quel résultat. Jamais de contenu clinique, mot de passe ni jeton.
 */
const journalSchema = new mongoose.Schema({
  acteur: { type: auteurSchema, default: undefined },
  /** ex. dossier.lecture, consultation.finalisation, acces.refuse (voir config/audit.js). */
  action: { type: String, required: true, index: true },
  resultat: { type: String, enum: ['autorisé', 'refusé'], default: 'autorisé' },
  patienteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patiente', default: null, index: true },
  ressource: {
    type: { type: String, default: null },
    id: { type: String, default: null },
  },
  /** Métadonnées minimales non sensibles (noms de champs modifiés, statut…). */
  details: { type: mongoose.Schema.Types.Mixed, default: undefined },
  methode: { type: String, default: null },
  route: { type: String, default: null },
  requeteId: { type: String, default: null },
  le: { type: Date, default: Date.now, index: true },
}, { toJSON: { transform: versJson }, versionKey: false });

// Ajout seul : toute modification ou suppression par l'application est refusée.
const interdit = function () {
  throw new Error('Le journal d’audit ne peut être ni modifié ni supprimé.');
};
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndReplace']) {
  journalSchema.pre(op, interdit);
}
journalSchema.pre('save', function () {
  if (!this.isNew) interdit();
});

module.exports = mongoose.model('JournalAudit', journalSchema, 'journal_audit');
