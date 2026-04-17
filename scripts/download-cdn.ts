const files: Record<string, string> = {
  "tailwind.js":   "https://cdn.tailwindcss.com/3.4.17",
  "alpine.js":     "https://unpkg.com/alpinejs@3/dist/cdn.min.js",
  "chart.js":      "https://unpkg.com/chart.js@4/dist/chart.umd.min.js",
  "prism.css":     "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-okaidia.min.css",
  "prism.js":      "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js",
  "prism-bash.js": "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-bash.min.js",
  "prism-toml.js": "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-toml.min.js",
}

for (const [name, url] of Object.entries(files)) {
  const res = await fetch(url)
  await Bun.write(`src/assets/cdn/${name}`, res)
  console.log("Downloaded", name)
}
