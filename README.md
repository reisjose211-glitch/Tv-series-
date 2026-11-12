# Binged

A phone-friendly web app to track the TV series you watch.

- **Explore** – search, trending, popular, top rated, browse by streaming service and genre, and recommendations based on your ratings
- **Library** – everything you have added, filtered by status, favourites or your own custom lists, optionally grouped by service
- **Watched** – all your finished series in one list, rated out of 10 (half points allowed), with a streaming-service filter and sorting
- **To Watch** – your watchlist, what you are currently watching, and a random "pick something for me" button
- **Stats** – totals, average rating, series per service, favourite genres and your top rated

Your library is saved in your browser on your device. Use **Settings → Export my data** to back it up or move it.

## Set-up

None needed: a TMDB API key is built into `app.js` (`BUILT_IN_KEY`). To use a different key, paste it in **Settings**;
a key saved there takes priority. Free keys are available at <https://www.themoviedb.org/settings/api>.

## Put it online with GitHub Pages

1. Merge this code into the `main` branch.
2. In the repository on GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   choose `main` and `/ (root)`, then Save.
3. After a minute the app is live at `https://<your-username>.github.io/<repository-name>/`.
   On your phone, open it and choose **Add to Home Screen**.

## Run locally

No build step. Serve the folder with any static server, e.g. `python3 -m http.server`, and open <http://localhost:8000>.

---

This product uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability data is provided by JustWatch.
