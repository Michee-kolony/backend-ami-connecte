// Carte patiente au format carte bancaire (85,6 × 54 mm), recto-verso, avec un QR code.
// La carte ne porte aucune donnée médicale : elle peut être perdue ou vue par un tiers.
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const Etablissement = require('../models/Etablissement');
const { journaliser } = require('../config/audit');
const { lireFichier } = require('../config/r2');
const { trouverPatiente } = require('./patientes');

const MM = 72 / 25.4;
const LARGEUR = 85.6 * MM;
const HAUTEUR = 54 * MM;
const BLEU = '#0055a5';
const BLEU_FONCE = '#13295f';
const VERT = '#2b9655';
const GRIS = '#64748b';
const ENCRE = '#0f172a';
const LOGO = path.join(__dirname, '..', 'assets', 'logo-icon.png');

/** « https://domaine » d'une adresse http(s), sinon null (valeur absente ou douteuse). */
function origineValide(valeur) {
  try {
    const u = new URL(valeur);
    return ['http:', 'https:'].includes(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Domaine du site qui demande la carte (Vercel, domaine perso…) : envoyé par le tableau de bord
 * (?site=), sinon en-têtes Origin / Referer du navigateur, sinon APP_URL.
 */
function origineSite(req) {
  return origineValide(req.query.site) || origineValide(req.get('origin')) || origineValide(req.get('referer'));
}

/** Adresse du dossier dans le tableau de bord : le QR code ouvre le dossier (connexion médecin requise). */
function lienDossier(numero, origine) {
  const base = (origine || process.env.APP_URL || 'http://localhost:4200').replace(/\/$/, '');
  return `${base}/admin/patientes/${encodeURIComponent(numero)}`;
}

/** pdfkit ne lit que le JPEG et le PNG (les photos WebP sont remplacées par les initiales). */
function imageLisible(buffer) {
  if (!buffer || buffer.length < 4) return false;
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  const png = buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG';
  return jpeg || png;
}

const jourFr = (iso) => (iso
  ? new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`))
  : null);

function genererPdf({ patiente, etablissement, photo, qr, delivreePar }) {
  const doc = new PDFDocument({ size: [LARGEUR, HAUTEUR], margin: 0, autoFirstPage: false, info: {
    Title: `Carte patiente ${patiente.numero}`, Author: 'AMI Santé Connect', Subject: 'Carte de suivi prénatal',
  } });
  const morceaux = [];
  doc.on('data', (m) => morceaux.push(m));
  const fin = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(morceaux))));

  // ------------------------------- RECTO -------------------------------
  doc.addPage();
  doc.rect(0, 0, LARGEUR, HAUTEUR).fill('#ffffff');
  // Bandeau
  doc.rect(0, 0, LARGEUR, 14 * MM).fill(BLEU);
  doc.rect(0, 14 * MM, LARGEUR, 0.8 * MM).fill(VERT);
  try {
    doc.image(LOGO, 3 * MM, 2.5 * MM, { width: 9 * MM, height: 9 * MM });
  } catch { /* logo absent : bandeau sans logo */ }
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9).text('AMI Santé Connect', 13.5 * MM, 3.4 * MM, { lineBreak: false });
  doc.font('Helvetica').fontSize(6.2).fillColor('#dbeafe').text('Carte de suivi prénatal', 13.5 * MM, 7.6 * MM, { lineBreak: false });
  doc.font('Helvetica').fontSize(5).fillColor('#dbeafe').text('République Démocratique du Congo', 13.5 * MM, 10.4 * MM, { lineBreak: false });

  // Photo (ou initiales)
  const px = 4 * MM;
  const py = 17.5 * MM;
  const pw = 19 * MM;
  const ph = 23.5 * MM;
  doc.save();
  doc.roundedRect(px, py, pw, ph, 2 * MM).clip();
  if (photo) {
    doc.image(photo, px, py, { cover: [pw, ph], align: 'center', valign: 'center' });
  } else {
    doc.rect(px, py, pw, ph).fill('#eef5fd');
    const initiales = `${(patiente.prenom || '').charAt(0)}${patiente.nom.charAt(0)}`.toUpperCase();
    doc.fillColor(BLEU).font('Helvetica-Bold').fontSize(16).text(initiales, px, py + ph / 2 - 7, { width: pw, align: 'center' });
  }
  doc.restore();
  doc.roundedRect(px, py, pw, ph, 2 * MM).lineWidth(0.6).strokeColor('#cbd5e1').stroke();

  // Identité
  const tx = 26 * MM;
  const tw = 33 * MM;
  doc.fillColor(GRIS).font('Helvetica').fontSize(4.6).text('NOM ET POSTNOM', tx, 17.5 * MM, { lineBreak: false });
  doc.fillColor(ENCRE).font('Helvetica-Bold').fontSize(8).text(`${patiente.nom} ${patiente.postnom || ''}`.trim(), tx, 19.4 * MM, { width: tw, height: 7 * MM, ellipsis: true });
  doc.fillColor(GRIS).font('Helvetica').fontSize(4.6).text('PRÉNOM', tx, 25 * MM, { lineBreak: false });
  doc.fillColor(ENCRE).font('Helvetica-Bold').fontSize(7.4).text(patiente.prenom || '—', tx, 26.9 * MM, { width: tw, height: 4 * MM, ellipsis: true });
  const naissance = patiente.dateNaissance ? `Née le ${jourFr(patiente.dateNaissance)}` : patiente.age() != null ? `${patiente.age()} ans (âge déclaré)` : '';
  doc.fillColor(GRIS).font('Helvetica').fontSize(5.6).text(naissance, tx, 31.6 * MM, { width: tw, lineBreak: false });

  // Numéro du dossier
  doc.roundedRect(tx, 35 * MM, tw, 6 * MM, 1.2 * MM).fill('#eef5fd');
  doc.fillColor(GRIS).font('Helvetica').fontSize(4.2).text('N° DE DOSSIER', tx + 1.6 * MM, 35.7 * MM, { lineBreak: false });
  doc.fillColor(BLEU_FONCE).font('Courier-Bold').fontSize(8).text(patiente.numero, tx + 1.6 * MM, 37.6 * MM, { lineBreak: false });

  // QR code
  const qs = 21.5 * MM;
  const qx = LARGEUR - qs - 3.2 * MM;
  const qy = 17.5 * MM;
  doc.roundedRect(qx - 0.8 * MM, qy - 0.8 * MM, qs + 1.6 * MM, qs + 1.6 * MM, 1.2 * MM).lineWidth(0.6).strokeColor('#cbd5e1').stroke();
  doc.image(qr, qx, qy, { width: qs, height: qs });
  doc.fillColor(GRIS).font('Helvetica').fontSize(4.4).text('Scanner pour ouvrir le dossier', qx - 2 * MM, qy + qs + 1.4 * MM, { width: qs + 4 * MM, align: 'center' });

  // Pied
  doc.rect(0, HAUTEUR - 8.5 * MM, LARGEUR, 8.5 * MM).fill('#f8fafc');
  doc.fillColor(BLEU).font('Helvetica-Bold').fontSize(5.4)
    .text(etablissement?.nom ?? 'Établissement non renseigné', 4 * MM, HAUTEUR - 7 * MM, { width: LARGEUR - 8 * MM, lineBreak: false, ellipsis: true });
  doc.fillColor(GRIS).font('Helvetica').fontSize(4.6)
    .text(`Présentez cette carte à chaque consultation · Délivrée le ${new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Kinshasa' }).format(new Date())}`,
      4 * MM, HAUTEUR - 4.2 * MM, { width: LARGEUR - 8 * MM, lineBreak: false, ellipsis: true });

  // ------------------------------- VERSO -------------------------------
  doc.addPage();
  doc.rect(0, 0, LARGEUR, HAUTEUR).fill('#ffffff');
  doc.rect(0, 0, 3 * MM, HAUTEUR).fill(BLEU);
  doc.rect(3 * MM, 0, 0.8 * MM, HAUTEUR).fill(VERT);
  const vx = 7 * MM;
  const vw = LARGEUR - vx - 4 * MM;
  doc.fillColor(BLEU_FONCE).font('Helvetica-Bold').fontSize(7.5).text('Mon suivi de grossesse', vx, 4 * MM, { width: vw });
  doc.fillColor(ENCRE).font('Helvetica').fontSize(5.4).text(
    'Venez à tous vos rendez-vous de consultation prénatale avec cette carte. Votre dossier est partagé entre les médecins de la plateforme.',
    vx, 8.6 * MM, { width: vw, lineGap: 0.6 },
  );

  doc.roundedRect(vx, 17 * MM, vw, 11 * MM, 1.5 * MM).fill('#fff1f2');
  doc.fillColor('#be123c').font('Helvetica-Bold').fontSize(5.6).text('EN CAS D’URGENCE', vx + 2 * MM, 18.6 * MM, { width: vw - 4 * MM });
  doc.fillColor('#881337').font('Helvetica').fontSize(5.1).text(
    'Saignements, douleurs fortes, fièvre, maux de tête intenses, convulsions ou bébé qui bouge moins : rendez-vous immédiatement à l’établissement de santé le plus proche.',
    vx + 2 * MM, 21.4 * MM, { width: vw - 4 * MM, lineGap: 0.4 },
  );

  doc.fillColor(GRIS).font('Helvetica').fontSize(4.6).text('ÉTABLISSEMENT DE SUIVI', vx, 32.5 * MM);
  doc.fillColor(ENCRE).font('Helvetica-Bold').fontSize(6.2).text(etablissement?.nom ?? '—', vx, 34.6 * MM, { width: vw, lineBreak: false, ellipsis: true });
  const coordonnees = [etablissement?.adresse, etablissement?.telephone && `Tél. ${etablissement.telephone}`].filter(Boolean).join(' · ');
  doc.fillColor(ENCRE).font('Helvetica').fontSize(5.2).text(coordonnees || '—', vx, 37.8 * MM, { width: vw, height: 6 * MM, ellipsis: true });

  doc.moveTo(vx, HAUTEUR - 8.5 * MM).lineTo(LARGEUR - 4 * MM, HAUTEUR - 8.5 * MM).lineWidth(0.4).strokeColor('#e2e8f0').stroke();
  doc.fillColor(GRIS).font('Helvetica').fontSize(4.4).text(
    `Carte personnelle — en cas de perte, signalez-la à votre établissement. Délivrée par ${delivreePar}.`,
    vx, HAUTEUR - 6.8 * MM, { width: vw, lineGap: 0.3 },
  );

  doc.end();
  return fin;
}

/** GET /api/patientes/:id/carte — PDF de la carte (médecins) ; chaque génération est journalisée. */
exports.carte = async (req, res) => {
  const patiente = await trouverPatiente(req.params.id);
  const [etablissement] = patiente.etablissementId ? await Etablissement.actifsParIds([patiente.etablissementId]) : [];
  const brute = await lireFichier(patiente.photoCle);
  const qr = await QRCode.toBuffer(lienDossier(patiente.numero, origineSite(req)), {
    errorCorrectionLevel: 'M', margin: 1, width: 360, color: { dark: BLEU_FONCE, light: '#ffffff' },
  });
  const s = req.soignant;
  const pdf = await genererPdf({
    patiente, etablissement, qr,
    photo: imageLisible(brute) ? brute : null,
    delivreePar: `${s.role.startsWith('Médecin') ? 'Dr ' : ''}${s.prenom} ${s.nom}`,
  });
  await journaliser(req, { action: 'patiente.carte', patienteId: patiente._id, ressource: { type: 'patiente', id: patiente.numero } });
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="carte-${patiente.numero}.pdf"`,
    'Cache-Control': 'no-store',
  });
  res.send(pdf);
};

exports.lienDossier = lienDossier;
exports.origineSite = origineSite;
