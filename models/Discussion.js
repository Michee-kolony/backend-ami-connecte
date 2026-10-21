const mongoose = require('mongoose');
const { versJson } = require('./commun');

/** Discussion privée entre deux soignants (médecins et infirmier·ères). */
const discussionSchema = new mongoose.Schema({
  participants: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Soignant' }],
    validate: { validator: (v) => v.length === 2, message: 'Une discussion réunit deux soignants.' },
  },
  /** « idA:idB » trié : une seule discussion par paire de soignants. */
  cle: { type: String, required: true, unique: true },
  dernierMessageLe: { type: Date, default: null, index: true },
}, { timestamps: true, toJSON: { transform: versJson } });

discussionSchema.index({ participants: 1 });

discussionSchema.statics.cleDe = (a, b) => [String(a), String(b)].sort().join(':');

discussionSchema.methods.aPourParticipant = function (soignantId) {
  return this.participants.some((p) => String(p._id ?? p) === String(soignantId));
};

module.exports = mongoose.model('Discussion', discussionSchema);
