# Vault Chat — Kurulum

Yerel, Docker'sız bir SvelteKit sohbet uygulaması. Kasandaki notlar üzerinde
RAG yapar, Ollama'daki modellerle konuşur. Tek Node süreci, `localhost`'a bağlı.

## Ön koşullar

1. **Node.js 22+** (zaten kurulu: `node --version`).
2. **Ollama** kurulu ve çalışıyor olmalı: https://ollama.com
   ```bash
   ollama serve
   ```
3. Gerekli modelleri çek:
   ```bash
   ollama pull qwen3:8b
   ollama pull nomic-embed-text
   # isteğe bağlı, derin oturumlar için:
   ollama pull qwen3:30b-a3b
   ```

## Kurulum

```bash
cd vault-chat
npm install
```

`.env` dosyası zaten `.env.example`'dan oluşturuldu. Gerekirse aç ve kontrol et:

```
VAULT_PATH=..                          # vault kökü (bu dizinin bir üstü)
OLLAMA_URL=http://localhost:11434
INDEX_DB_PATH=./data/vault-index.db
PUBLIC_VAULT_NAME=First brain(Software based)   # Obsidian'da vault'un görünen adı
```

`PUBLIC_VAULT_NAME` kaynak çiplerindeki `obsidian://open?vault=...` linklerinin
doğru vault'u açması için gerekli — Obsidian'da **Ayarlar → Hakkında** kısmından
tam adı doğrula.

## İlk indeksleme

Sohbet edebilmek için önce kasan vektör indeksine dönüşmeli:

```bash
npm run index
```

Bu, `wiki/`, `notes/`, `cards/` vb. altındaki tüm `.md` dosyalarını tarar,
frontmatter'ı olmayanları uyarı ile atlar, geri kalanını parçalayıp
`nomic-embed-text` ile gömer ve `data/vault-index.db` içine yazar. sha256
tabanlı artımlı çalışır — değişmeyen dosyaları atlar, `pdf2md.py` ile aynı mantık.

Bayraklar:
- `npm run index -- --full` — hepsini sıfırdan yeniden indeksler (embed modeli
  değiştiyse bunu kullan).
- `npm run index -- --dry-run` — hiçbir şey yazmadan neyin değişeceğini raporlar.

## Günlük kullanım

```bash
npm run dev
```

`http://localhost:5173` açılır. Ders çalışıp not güncelledikten sonra, istediğin
an `npm run index` çalıştır — uygulama açıkken bile çakışma olmaz (WAL modu).

Otomatik izleme istersen (opsiyonel, varsayılan değil):

```bash
npm run index:watch
```

## Kalıcı kullanım (geliştirme sunucusu olmadan)

```bash
npm run build
node build
```

## Sorun giderme

- **"Ollama sunucusuna ulaşılamadı"** → `ollama serve` çalışıyor mu, `OLLAMA_URL` doğru mu kontrol et.
- **Model listesi boş / ModelPicker hata veriyor** → `ollama pull qwen3:8b` çalıştırıldı mı?
- **Kaynak bulunamıyor / cevaplar alakasız** → `npm run index` çalıştırıldı mı, index güncel mi?
  Ayrıntılı teşhis sırası için `.claude/skills/vault-rag-index/SKILL.md` içindeki
  "Quality debugging checklist" bölümüne bak.
- **Matematik render olmuyor / `f(x)` gibi çıplak kod görünüyor** →
  `.claude/skills/svelte-vault-chat/SKILL.md` içindeki acid-test string'leriyle
  `src/lib/markdown.ts` pipeline'ını doğrula.
