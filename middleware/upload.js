const multer = require('multer');

const imagesSeulement = (req, file, cb) => /^image\/(jpeg|png|webp)$/.test(file.mimetype)
  ? cb(null, true)
  : cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));

// Fichiers gardés en mémoire puis envoyés directement vers R2.
const photo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: imagesSeulement,
}).single('photo');

const photosEtablissement = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 6 },
  fileFilter: imagesSeulement,
}).array('photos', 6);

/** Traduit les erreurs multer en réponses 400 lisibles. */
function avecMessages(upload, tailleMax) {
  return (req, res, next) => upload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: `Chaque photo doit faire ${tailleMax} au maximum.` });
    if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ message: '6 photos au maximum.' });
    if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ message: 'Format accepté : JPG, PNG ou WebP.' });
    next(err);
  });
}

module.exports = {
  televerserPhoto: avecMessages(photo, '2 Mo'),
  televerserPhotosEtablissement: avecMessages(photosEtablissement, '5 Mo'),
};
