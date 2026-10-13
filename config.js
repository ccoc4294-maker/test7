/* ---------------------------------------------------------------
   Primo Barbershop — configuration
   1. Paste your Supabase Project URL and anon (public) key below.
      Supabase dashboard > Project Settings > API.
      NEVER paste the "service_role" key here — it must stay secret.
   2. Edit promos, reviews and FAQ whenever you like.
   Services, prices, shop hours, staff and bookings live in the
   database (see README.md).
---------------------------------------------------------------- */
window.PRIMO = {
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-ANON-PUBLIC-KEY',

  // Promos hide themselves after the "expires" date (YYYY-MM-DD, Manila time).
  // "service" is the service id from the services table (e.g. 'combo'); leave '' for none.
  PROMOS: [
    { name: 'Cut + Beard Combo', price: 350, was: 450, service: 'combo', expires: '2026-12-31' },
    { name: 'Bring a Friend', desc: 'Book together, both get 10% off any haircut.', service: '', expires: '2026-12-31' }
  ],

  REVIEWS: [
    { name: 'John', text: 'Clean fade and mabilis service. Been coming here for months.' },
    { name: 'Mico', text: 'Mark always gets my fade exactly right. Never had a bad cut here.' },
    { name: 'Rico', text: 'The hot towel shave is worth it alone. Relaxing and precise.' }
  ],

  FAQS: [
    { q: 'Do you accept walk-ins?', a: 'Yes, subject to availability. Join the live walk-in queue from the Book Now tab.' },
    { q: 'Do I need an appointment?', a: 'Appointments are recommended, but walk-ins are always welcome.' },
    { q: 'Can I choose my barber?', a: 'Yes. Pick a specific barber when booking, or choose "Any barber" for the soonest open chair.' },
    { q: 'What payment methods do you accept?', a: 'Cash and GCash.' },
    { q: 'Can I cancel my appointment?', a: 'Yes, up to 2 hours before your appointment, using your booking code and phone number.' }
  ]
};
