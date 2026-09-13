---
name: vault-registry
description: >
  Phase 8 of vault-agent-toolkit: remove the single-LIBRARY_PATH assumption
  and introduce a multi-vault data model. Use this skill whenever touching
  vault storage layout, the vault registry (data/vaults.json), any module
  that used to read LIBRARY_PATH/INDEX_DB_PATH/STUDY_DB_PATH directly
  (library.ts, retrieve.ts, study-db.ts, incrementalIndex.ts), the indexer
  CLI, the migration script, or the Tauri sidecar's env wiring. This is a
  backend/data-model phase, not a UI phase — see frontend-revamp (Phase 9)
  for the real vault-switcher UI.
scope: server
---

# Multi-Vault Architecture — Phase 8

## Takılma disiplini (ortak kural)

Aynı hata için en fazla 3 farklı çözüm denemesi yapılır. 3. deneme de
başarısızsa DUR: `docs/stuck-report.md` dosyasına (a) hatanın tam çıktısı,
(b) denenen 3 yaklaşım ve neden başarısız oldukları, (c) en güçlü hipotez
yazılır ve kullanıcıya danışılır. Aynı dosyada küçük değişiklikler
deneyerek 4., 5. tur ATILMAZ. Bir hata "çözüldü" sayılmadan önce doğrulama
komutu (test/build/çalıştırma) mutlaka koşulur; çıktısı görülmeden sonraki
adıma geçilmez. Her çalışma oturumu temiz git durumuyla başlar; 3 denemelik
döngü öncesi commit atılır ki başarısız denemeler `git checkout` ile geri
alınabilsin.

## Kilitlenen kararlar (yeniden tartışılmaz)

1. **Vault'lar uygulamaya aittir.** Kullanıcı bir klasör yolu değil, bir
   **isim** seçer. İçerik her zaman `data/vaults/<id>/library/` altında
   yaşar. Faz 5'in "yazma işlemleri asla kullanıcının gerçek klasörüne
   düşmez" duruşu (`library.ts`'teki `libraryRoot()` yorumu) burada da
   geçerli — Obsidian vault'u içe aktarma hâlâ tek yönlü kopyalama.
   Registry kaydındaki `path` alanı türetilmiş bir değerdir, kullanıcı
   girdisi değil.
2. **`id` kalıcıdır.** `name`'den türetilen bir slug, oluşturulduktan sonra
   değişmez (rename yalnızca `name`'i günceller). Okunabilir klasör adları
   ve `npm run index -- --vault matematik` gibi CLI kullanımı için UUID'ye
   tercih edildi.
3. **`chats.db` global kalır, `vault_id` kolonu eklenir.** `study.db` ve
   `index.db` ise vault başına ayrı dosyadır. Gerekçe: study artifact'ları
   `source_path` üzerinden vault'a sıkı bağlı (ayrı dosya = migration
   gerektirmeyen temiz ayrım), sohbetler ise ileride vault-üstü "son
   konuşmalar" görünümü isteyebilir.
4. **FTS eklenmiyor.** Bugünkü retrieval saf vektör KNN
   (`retrieve.ts`'teki `vec_chunks` sorgusu); kodda hiçbir FTS tablosu yok.
   `includedPaths` scoped-retrieval filtresi mevcut vektör aramasına
   path-prefix olarak iner. Hibrit arama (FTS5 + BM25) bu fazın kapsamı
   DIŞINDA — ayrı bir faz olarak roadmap'e not düşülür, burada
   uygulanmaz.
5. **Bu faz bir UI özelliği değildir.** `/settings/vaults` altına yalnızca
   CRUD'u tetikleyecek kadar süssüz, minimal bir panel yazılır (mevcut
   scoped-CSS deseniyle). Görsel yatırım yapılmaz — Faz 9 (shadcn-svelte
   revizyonu) bu paneli tamamen yeniden yazacak.

## Depolama düzeni (hedef)

```
data/
  vaults.json                 # registry + activeVaultId
  vaults/<id>/
    library/                  # eski data/library  (_meta/ aynen içinde kalır)
    index.db                  # eski data/vault-index.db
    study.db                  # eski data/study.db
  chats.db                    # GLOBAL, vault_id + included_paths kolonlarıyla
  secrets.json, providers.json, skills/    # global, dokunulmuyor
```

`_meta/` (import-log, staging, originals, settings) bilinçli olarak
`library/` içinde bırakılır: `walkTree` onu zaten filtreler ve
staging/originals/settings yolları değişmeden çalışmaya devam eder.

## Registry sözleşmesi (`src/lib/server/vaults.ts`)

- **`$env/dynamic/private` KULLANMA, sadece `process.env`.** Bu modül hem
  SvelteKit sunucusu hem de standalone indexer CLI'ı (`indexer/*`)
  tarafından import edilir — `indexer/db.ts`'in `src/lib/server/*`'ı
  SvelteKit-bağımsız import etmesiyle aynı desen.
- Registry yazımı atomik: temp dosyaya yaz + `renameSync`.
- `resolveVault(id?)` bilinmeyen id'de fırlatır; route katmanı bunu 404'e
  çevirir. `id` verilmezse `activeVaultId`'ye düşer.
- **Bozuk registry = kalıcı kilitlenme değil.** `data/vaults.json`
  parse edilemiyorsa, Tauri `read_config()`'teki fixten aynı ders:
  hata logla, yok say, ilk kurulum akışına (migration'ı yeniden tetikleme)
  düş — asla `Err` fırlatıp kullanıcıyı çıkmaz sokağa sokma.
- `deleteVault` yıkıcıdır — API katmanı açık onay ister; servis
  fonksiyonu sessizce silmez, önce silinecek sohbet/test sayısını
  raporlayan bir `describeVaultDeletion(id)` sunar.

## İstek başına vault çözümlemesi

Faz 9'un `/vault/[id]/...` route'larını getirene kadarki köprü:
`vaultFromRequest(event)` yardımcısı `?vault=<id>` query param'ını veya
JSON gövdesindeki `vault` alanını okur, yoksa `activeVaultId`'ye düşer.
Faz 8'de UI parametre göndermez (aktif vault kullanılır); Faz 9'da UI
göndermeye başlar, backend sözleşmesi değişmez.

## Scoped retrieval inceliği

`includedPaths` verildiğinde `retrieve.ts`'teki `OVERFETCH_FACTOR`
(bugün 3) yeterli değildir — kapsam darsa en yakın `k*3` chunk'ın hepsi
filtreye takılıp sonuç sessizce boş dönebilir. `includedPaths` verilince
çarpan belirgin biçimde yükseltilir (≥10). Dönüş tipi
`{ chunks, narrowScope }` olmalı: `narrowScope` = eşiği geçen eşleşme
vardı ama hepsi kapsam filtresine takıldı — bu ayrım olmadan "kaynak yok"
ile "kapsam dar" API'de aynı görünür ve Faz 9 doğru öneriyi gösteremez.

## Migration

`scripts/migrate-vaults.mjs`, idempotent (`data/vaults.json` varsa no-op),
`--dry-run` destekli. `default` id'li vault yaratır, eski
`LIBRARY_PATH`/`INDEX_DB_PATH`/`STUDY_DB_PATH` içeriğini oraya taşır,
`chats.db`'ye `vault_id='default'` yazar.

**Windows uyarısı:** aynı disk içi `fs.renameSync` kullan.
`node:fs`'in `cpSync`/`rmSync`'i bu repo'nun Türkçe karakterli yolunda
Faz 7'de belgelenen sebeplerle başarısız oluyor — `renameSync`
başarısız olursa `scripts/stage-server.mjs`'teki robocopy/PowerShell
fallback desenine düş.

Masaüstünde (Tauri) migration kullanıcı tarafından CLI ile tetiklenemez;
sunucu açılışında `data/vaults.json` yoksa otomatik bir kez koşmalı.

## Bitti tanımı

- [ ] İki vault oluşturulup ikisine ayrı kaynak ingest edilebiliyor;
      arama sonuçları vault'lar arasında sızmıyor (aynı soru iki vault'ta
      farklı kaynak döndürüyor).
- [ ] `includedPaths` filtresiyle yapılan sorgu yalnızca o path'lerden
      chunk döndürüyor, `narrowScope` doğru ayırt ediliyor (birim test).
- [ ] Migration sonrası eski sohbetler ve indeks "default" vault altında
      aynen çalışıyor; ikinci migration koşusu no-op.
- [ ] Faz 6 provider katmanı ve Faz 5 ingest kuyruğu değişiklikten
      etkilenmeden çalışıyor (regresyon).
- [ ] Masaüstü paketinde otomatik migration + sohbet uçtan uca çalışıyor.

## Kapsam dışı (bu fazda yapılmaz)

FTS5/hibrit arama; Faz 9'un vault seçici/tri-state kaynak ağacı UI'ı;
vault başına farklı embed modeli; vault paylaşımı/export-import;
çoklu-kullanıcı erişim kontrolü.
