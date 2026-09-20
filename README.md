# Property Tracker — Firebase

A GitHub Pages + Firebase app for tracking properties, garage doors, garage door openers, and service-call history.

This is the expanded version of the original Garage Door Install Tracker. Existing installation records are preserved and automatically treated as property records with their original door information migrated into the property's door list.

## Features

- Private Firebase email/password sign-in
- Property/address records
- Multiple garage doors per property
- Multiple openers per property
- Service-call history tied to each property
- Separate add/edit forms for doors, openers, and service calls
- Optional install dates
- Search across property, door, opener, and service information
- Property map with automatic and manual pin placement
- CSV export
- Mobile-friendly layout
- No photo storage

## Data storage

The app continues to use the existing Firestore `installations` collection so the existing Firebase security rules remain valid. Each document is now treated as a property record and can contain `doors`, `openers`, and `serviceCalls` arrays.

## GitHub Pages

Published from `main` / `(root)`.

Expected site:

`https://lavacaarrowdad.github.io/garage-door-install-tracker-firebase/`
