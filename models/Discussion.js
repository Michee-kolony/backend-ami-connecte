const mongoose = require('mongoose');
const { versJson } = require('./commun');

/**
 * Discussion privée à deux : entre deux soignants, ou entre une patiente (application mobile)
 * et un soignant. Dans ce dernier cas, `patienteId` désigne celui des deux participants qui est
 * la patiente ; messages, accusés de lecture et temps réel fonctionnent de la même façon.
 */
const discussionSchema = new mongoose.Schema({
  participants: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Soignant' }],
    validate: { validator: (v) => v.length === 2, message: 'Une discussion réunit deux participants.' },
  },
  patienteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patiente', default: null, index: true },
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
