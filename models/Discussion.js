const mongoose = require('mongoose');
const { versJson } = require('./commun');

/**
 * Discussion privée à deux : entre deux soignants, entre une patiente (application mobile) et un
 * soignant, ou entre un relais communautaire (application RECO) et un soignant ou un chauffeur
 * de son établissement. `patienteId`, `recoId` et `chauffeurId` désignent celui des participants
 * qui n'est pas un soignant ; messages, accusés de lecture et temps réel fonctionnent de la même façon.
 */
const discussionSchema = new mongoose.Schema({
  participants: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Soignant' }],
    validate: { validator: (v) => v.length === 2, message: 'Une discussion réunit deux participants.' },
  },
  patienteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patiente', default: null, index: true },
  recoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Reco', default: null, index: true },
  chauffeurId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chauffeur', default: null, index: true },
  /** Membre du comité de pilotage, en discussion avec un médecin chef. */
  membreComiteId: { type: mongoose.Schema.Types.ObjectId, ref: 'MembreComite', default: null, index: true },
  /** « idA:idB » trié : une seule discussion par paire de participants. */
  cle: { type: String, required: true, unique: true },
  dernierMessageLe: { type: Date, default: null, index: true },
}, { timestamps: true, toJSON: { transform: versJson } });

discussionSchema.index({ participants: 1 });

discussionSchema.statics.cleDe = (a, b) => [String(a), String(b)].sort().join(':');

discussionSchema.methods.aPourParticipant = function (soignantId) {
  return this.participants.some((p) => String(p._id ?? p) === String(soignantId));
};

module.exports = mongoose.model('Discussion', discussionSchema);
