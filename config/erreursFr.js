// Messages d'erreur en français : validation Mongoose (messages par défaut en anglais), erreurs
// de conversion, et erreurs des bibliothèques HTTP (corps JSON, fichiers, adresse).
// Chargé en tout premier dans app.js : Mongoose fige le message d'un validateur à la
// définition du schéma, donc avant le chargement des modèles.
const mongoose = require('mongoose');

/** Noms lisibles des champs les plus fréquents ; les autres sont déduits du nom technique. */
const LIBELLES = {
  nom: 'nom', postnom: 'post-nom', prenom: 'prénom', email: 'adresse e-mail', motDePasse: 'mot de passe',
  telephone: 'téléphone', telephone2: 'second téléphone', dateNaissance: 'date de naissance', ageDeclare: 'âge déclaré',
  age: 'âge', sexe: 'sexe', statut: 'statut', role: 'rôle', matricule: 'matricule', province: 'province',
  poidsKg: 'poids (kg)', poidsG: 'poids (g)', tailleCm: 'taille (cm)', temperature: 'température',
  temperatureAxillaire: 'température axillaire', pouls: 'pouls', taSystolique: 'TA systolique', taDiastolique: 'TA diastolique',
  bcf: 'BCF', hauteurUterineCm: 'hauteur utérine (cm)', dilatationCm: 'dilatation (cm)', effacementPct: 'effacement (%)',
  perimetreCranienCm: 'périmètre crânien (cm)', perimetreBrachialCm: 'périmètre brachial (cm)', saO2: 'saturation en oxygène',
  frequenceRespiratoire: 'fréquence respiratoire', respiration: 'fréquence respiratoire', contractions10min: 'contractions / 10 min',
  dureeContractionsSec: 'durée des contractions (s)', pertesSangMl: 'pertes de sang (ml)', nombreEnfants: 'nombre d’enfants',
  gestite: 'gestité', parite: 'parité', avortements: 'avortements', enfantsVivants: 'enfants en vie', cesariennes: 'césariennes',
  agSemaines: 'âge gestationnel (semaines)', agJours: 'âge gestationnel (jours)', agReferenceJours: 'âge gestationnel',
  ddr: 'DDR', dpa: 'DPA', date: 'date', heure: 'heure', le: 'date et heure', neLe: 'date et heure de naissance',
  motif: 'motif', mode: 'mode', type: 'type', presentation: 'présentation', rang: 'rang de naissance', annee: 'année',
  produit: 'produit', dose: 'dose', code: 'code', titre: 'titre', contenu: 'contenu', texte: 'texte', degre: 'degré',
  etatCivil: 'état civil', etatMatrimonial: 'état matrimonial', creePar: 'auteur', mereId: 'mère', patienteId: 'patiente',
  grossesseId: 'grossesse', etablissementId: 'établissement', numero: 'numéro', adresse: 'adresse', occupation: 'occupation',
};

/** « naissance.apgar.m1.tonus » → « tonus » ; « tailleCm » → libellé, sinon « taille cm ». */
function libelle(chemin) {
  const dernier = String(chemin ?? '').split('.').filter((x) => x && !/^\d+$/.test(x)).pop() ?? '';
  return LIBELLES[dernier] ?? dernier.replace(/([a-z])([A-Z0-9])/g, '$1 $2').toLowerCase();
}

const jour = (v) => (v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString().slice(0, 10).split('-').reverse().join('/') : String(v));

const m = mongoose.Error.messages;
m.general.default = (p) => `Valeur invalide pour « ${libelle(p.path)} ».`;
m.general.required = (p) => `Le champ « ${libelle(p.path)} » est obligatoire.`;
m.general.allowNull = (p) => `Le champ « ${libelle(p.path)} » ne peut pas être vide.`;
m.Number.min = (p) => `« ${libelle(p.path)} » doit être supérieur ou égal à ${p.min} (valeur saisie : ${p.value}).`;
m.Number.max = (p) => `« ${libelle(p.path)} » doit être inférieur ou égal à ${p.max} (valeur saisie : ${p.value}).`;
m.Number.enum = (p) => `Valeur « ${p.value} » non autorisée pour « ${libelle(p.path)} ».`;
m.Date.min = (p) => `« ${libelle(p.path)} » ne peut pas être avant le ${jour(p.min)}.`;
m.Date.max = (p) => `« ${libelle(p.path)} » ne peut pas être après le ${jour(p.max)}.`;
m.String.enum = (p) => `Valeur « ${p.value} » non autorisée pour « ${libelle(p.path)} ».`;
m.String.match = (p) => `Format invalide pour « ${libelle(p.path)} ».`;
m.String.minlength = (p) => `« ${libelle(p.path)} » doit contenir au moins ${p.minlength} caractères.`;
m.String.maxlength = (p) => `« ${libelle(p.path)} » doit contenir au plus ${p.maxlength} caractères.`;

/** Valeur qui n'a pas pu être convertie (nombre, date, identifiant…). */
function messageConversion(e) {
  if (e.kind === 'ObjectId') return e.path === '_id' ? 'Identifiant invalide.' : `Identifiant invalide pour « ${libelle(e.path)} ».`;
  const attendu = { Number: 'un nombre', Date: 'une date valide', Boolean: 'oui ou non', String: 'un texte' }[e.kind];
  return `Valeur invalide pour « ${libelle(e.path)} »${attendu ? ` : ${attendu} est attendu` : ''}.`;
}

/** Premier message lisible d'une erreur de validation Mongoose (ou de conversion). */
function messageValidation(err, defaut = 'Données invalides.') {
  if (err instanceof mongoose.Error.CastError) return messageConversion(err);
  const e = Object.values(err?.errors ?? {})[0];
  if (!e) return defaut;
  if (e instanceof mongoose.Error.CastError) return messageConversion(e);
  if (e instanceof mongoose.Error.ValidationError) return messageValidation(e, defaut);
  return e.message || defaut;
}

const MESSAGES_CORPS = {
  'entity.parse.failed': [400, 'Données envoyées invalides (format JSON incorrect).'],
  'entity.too.large': [413, 'Données envoyées trop volumineuses.'],
  'parameters.too.many': [413, 'Trop de champs dans le formulaire.'],
  'request.aborted': [400, 'Envoi interrompu, réessayez.'],
  'encoding.unsupported': [415, 'Encodage des données non pris en charge.'],
  'charset.unsupported': [415, 'Jeu de caractères non pris en charge.'],
};

const MESSAGES_FICHIERS = {
  LIMIT_FILE_SIZE: 'Fichier trop volumineux.',
  LIMIT_FILE_COUNT: 'Trop de fichiers envoyés.',
  LIMIT_FIELD_COUNT: 'Trop de champs dans le formulaire.',
  LIMIT_FIELD_KEY: 'Nom de champ trop long.',
  LIMIT_FIELD_VALUE: 'Valeur de champ trop longue.',
  LIMIT_PART_COUNT: 'Formulaire trop volumineux.',
  LIMIT_UNEXPECTED_FILE: 'Fichier inattendu ou format non accepté.',
  MISSING_FIELD_NAME: 'Champ de fichier sans nom.',
};

/**
 * Erreur non prévue par les contrôleurs → { status, message } en français, ou null si elle
 * doit rester une erreur interne (500).
 */
function traduire(err) {
  if (MESSAGES_CORPS[err.type]) {
    const [status, message] = MESSAGES_CORPS[err.type];
    return { status, message };
  }
  if (err.name === 'MulterError') return { status: 400, message: MESSAGES_FICHIERS[err.code] ?? 'Envoi du fichier impossible.' };
  if (/^Unexpected end of form|^Multipart: Boundary not found|^Malformed part header/.test(err.message ?? '')) {
    return { status: 400, message: 'Formulaire envoyé incomplet ou mal formé, réessayez.' };
  }
  if (err instanceof mongoose.Error.ValidationError || err instanceof mongoose.Error.CastError) return { status: 400, message: messageValidation(err) };
  if (err instanceof URIError || /^Failed to decode param/.test(err.message ?? '')) return { status: 400, message: 'Adresse invalide.' };
  if (err.code === 11000) return { status: 409, message: 'Cet enregistrement existe déjà (doublon).' };
  if (err.name === 'TokenExpiredError') return { status: 401, message: 'Session expirée, reconnectez-vous.' };
  if (err.name === 'JsonWebTokenError') return { status: 401, message: 'Session invalide, reconnectez-vous.' };
  return null;
}

module.exports = { libelle, messageValidation, traduire };
