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

/** Articles de conseils : 4 photos (5 Mo chacune, vérifié par le contrôleur) ou une vidéo (50 Mo). */
const mediasArticle = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 4 },
  fileFilter: (req, file, cb) => (/^(image\/(jpeg|png|webp)|video\/(mp4|webm|quicktime))$/.test(file.mimetype)
    ? cb(null, true)
    : cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname))),
}).array('medias', 4);

/** Échographie : compte rendu (PDF) ou images, 10 Mo chacun, 6 fichiers au plus. */
const fichiersEchographie = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 6 },
  fileFilter: (req, file, cb) => (/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.mimetype)
    ? cb(null, true)
    : cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname))),
}).array('fichiers', 6);

/** Traduit les erreurs multer en réponses 400 lisibles. */
function avecMessages(upload, tailleMax, { nombreMax = 6, formats = 'JPG, PNG ou WebP' } = {}) {
  return (req, res, next) => upload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: `Chaque fichier doit faire ${tailleMax} au maximum.` });
    if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ message: `${nombreMax} photos au maximum.` });
    if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ message: `Format accepté : ${formats}.` });
    next(err);
  });
}

module.exports = {
  televerserPhoto: avecMessages(photo, '2 Mo'),
  televerserPhotosEtablissement: avecMessages(photosEtablissement, '5 Mo'),
  televerserMediasArticle: avecMessages(mediasArticle, '50 Mo', { nombreMax: 4, formats: 'photos JPG, PNG ou WebP, vidéo MP4, WebM ou MOV' }),
  televerserFichiersEchographie: avecMessages(fichiersEchographie, '10 Mo', { nombreMax: 6, formats: 'compte rendu PDF ou images JPG, PNG, WebP' }),
};
