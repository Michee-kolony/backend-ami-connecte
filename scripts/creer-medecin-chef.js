// Crée le premier compte « Médecin chef de service », qui pourra ensuite ajouter tout le personnel.
// Usage : node scripts/creer-medecin-chef.js <email> <motDePasse> <prenom> <nom>
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');

process.loadEnvFile();
const Soignant = require('../models/Soignant');

async function main() {
  const [email, motDePasse, prenom, nom] = process.argv.slice(2);
  if (!email || !motDePasse || !prenom || !nom) {
    console.error('Usage : node scripts/creer-medecin-chef.js <email> <motDePasse> <prenom> <nom>');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  if (await Soignant.exists({ email: email.toLowerCase() })) {
    console.error(`Un compte existe déjà pour ${email}.`);
    process.exit(1);
  }
  const role = 'Médecin chef de service';
  const s = await Soignant.create({
    matricule: await Soignant.prochainMatricule(role),
    prenom, nom, postnom: '-', sexe: 'M',
    dateNaissance: '1980-01-01', lieuNaissance: 'Kinshasa', nationalite: 'Congolaise',
    pieceType: 'Carte d’électeur', pieceNumero: 'A-COMPLETER', adresse: 'À compléter', telephone: 'À compléter',
    numeroOrdre: `CNOM-INIT-${Date.now()}`, grade: 'Médecin spécialiste', specialite: 'Médecine générale',
    affectations: [{ etablissementId: 'ET-001', service: 'Direction' }],
    email, motDePasse: await bcrypt.hash(motDePasse, 12), role, doitChangerMotDePasse: false,
  });
  console.log(`Compte créé : ${s.email} (${s.matricule}, ${s.role})`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
