# Kasjer 3D – serwer multiplayer

1. `npm install`
2. `npm start`  (domyślnie port 3000, albo zmienna PORT)
3. W grze: Multiplayer → pole "Adres serwera" → np. `http://localhost:3000`
   albo wpisz adres na stałe w pliku gry: `const MP_URL_DEFAULT='https://twoj-serwer.onrender.com';`

Hosting (np. Render, Railway, Fly.io): zwykły "Web Service" z Node.js, komenda startowa `npm start`.
Na CrazyGames serwer musi działać po HTTPS (wss://).
Host (twórca lobby) liczy symulację sklepu; serwer tylko zarządza lobby i przekazuje wiadomości.
