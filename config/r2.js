const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Cloudflare R2 est compatible S3 : on utilise le SDK AWS avec l'endpoint R2.
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

/**
 * Envoie un fichier (reçu par multer en mémoire) dans le bucket, sous `dossier/`.
 * Retourne la clé de l'objet et son URL publique.
 */
async function envoyerFichier(fichier, dossier) {
  const cle = `${dossier}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${EXTENSIONS[fichier.mimetype] || 'bin'}`;
  try {
    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: cle,
      Body: fichier.buffer,
      ContentType: fichier.mimetype,
    }));
  } catch (err) {
    console.error('Envoi R2 échoué :', err.name, err.message);
    const erreur = new Error('Envoi du fichier impossible : stockage R2 mal configuré ou indisponible.');
    erreur.status = 502;
    throw erreur;
  }
  return { cle, url: `${process.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${cle}` };
}

async function supprimerFichier(cle) {
  await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: cle }));
}

/** Retrouve la clé d'un objet à partir de son URL publique (null si l'URL n'est pas celle du bucket). */
function cleDepuisUrl(url) {
  const base = `${process.env.R2_PUBLIC_URL.replace(/\/$/, '')}/`;
  return url && url.startsWith(base) ? decodeURIComponent(url.slice(base.length)) : null;
}

/**
 * Lien temporaire (15 min par défaut) vers un objet privé : utilisé pour les photos des patientes,
 * dont l'adresse publique n'est jamais communiquée. null si la signature est impossible.
 */
async function urlSignee(cle, secondes = 900) {
  if (!cle) return null;
  try {
    return await getSignedUrl(r2, new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: cle }), { expiresIn: secondes });
  } catch (err) {
    console.error('Signature R2 impossible :', err.name);
    return null;
  }
}

/** Contenu d'un objet (Buffer), ou null s'il est introuvable ou illisible. */
async function lireFichier(cle) {
  if (!cle) return null;
  try {
    const r = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: cle }));
    return Buffer.from(await r.Body.transformToByteArray());
  } catch (err) {
    console.error('Lecture R2 impossible :', err.name);
    return null;
  }
}

module.exports = { r2, envoyerFichier, supprimerFichier, cleDepuisUrl, urlSignee, lireFichier };
