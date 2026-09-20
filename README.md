# Garage Door Install Tracker — Firebase

Firebase version of the Garage Door Install Tracker. This repository is separate from the original Supabase version.

## Stack
- GitHub Pages
- Firebase Authentication (email/password)
- Cloud Firestore
- Leaflet + OpenStreetMap
- Nominatim street-level geocoding

## Features
- Private sign-in
- Add, edit, and delete installations
- Customer and address
- Manufacturer / model
- Door size
- Spring size and count
- Door type, color, and lift
- Install date
- Multiple doors per job
- Search
- CSV export
- Installation map
- Mobile-friendly layout

## Security
Each installation stores the signed-in user's Firebase UID in `userId`. Firestore rules restrict reads and writes to that user. The rules are also stored in `firestore.rules`.

## GitHub Pages
Enable **Settings → Pages → Deploy from a branch → main → /(root)**.

Expected site:
`https://lavacaarrowdad.github.io/garage-door-install-tracker-firebase/`

Firebase Authentication authorized domains must include:
`lavacaarrowdad.github.io`
