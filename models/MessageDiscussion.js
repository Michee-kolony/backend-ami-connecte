const mongoose = require('mongoose');

/** Message d'une discussion : le texte n'est jamais stocké en clair (voir config/chiffrement.js). */
const messageSchema = new mongoose.Schema({
  discussionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Discussion', required: true },
  auteurId: { type: mongoose.Schema.Types.ObjectId, ref: 'Soignant', required: true },
  contenu: {
    v: { type: Number, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    d: { type: String, required: true },
  },
  /** Accusés de lecture : qui a lu, et quand. */
  lusPar: [{ _id: false, soignantId: mongoose.Schema.Types.ObjectId, le: Date }],
}, { timestamps: true });

messageSchema.index({ discussionId: 1, createdAt: -1 });

module.exports = mongoose.model('MessageDiscussion', messageSchema, 'messages_discussions');
