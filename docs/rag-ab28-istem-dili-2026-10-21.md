# #28: İstem dili ve educational-agent A/B (2026-10-21)

**Soru:** qwen3:8b'ye giden Türkçe talimatlar (çekirdek istem ve `educational-agent` skill'i) modeli zorluyor mu? İngilizce istem ya da skill'i kapatmak cevabı iyileştirir mi?

**Cevap:** Hayır. 2×2'nin hiçbir hücresi arasında doğrulukta fark yok. Skill açıkken cevaplar uzuyor ve yavaşlıyor, doğruluk aynı kalıyor. Üretim istemi Türkçe kalıyor.

## Düzen

- **Varyantlar:** çekirdek istem dili {tr, en} × `educational-agent` {kapalı, açık}.
  - İngilizce istem `b3aa832` ile eklendi (`buildPromptMessages` `promptLanguage: 'en'`). Varsayılan 'tr' çıktısı testle eskisine sabitlendi.
  - Skill açık hücrelerde yalnız `educational-agent/SKILL.md` yüklendi. İngilizce hücrede aynı metnin elle yapılmış İngilizce çevirisi kullanıldı. Ek dosyalar (`references/`) araçsız koşuda zaten yüklenmiyor.
  - `(Answer in X.)` yönergesi iki dilde de aynı.
- **Sorular:** `golden-full.jsonl`'dan türe göre tabakalı 40 soru (`golden-ab28.jsonl`, tohum 7): 24 TR, 16 EN; 33 cevaplı, 4 cevapsız, 3 sohbet.
- **SUT:** qwen3:8b, num_ctx 8192, reranker kapalı, bellek bloğu kapalı. Ollama `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`.
- **Yargıç:** aynı yargıç istemi (`bench/lib/judge.ts`), 8 Claude Sonnet alt ajanı. 160 istem karıştırılıp 20'lik yığınlara bölündü, yani yargıç hangi varyantı puanladığını görmedi. 160/160 cevap `parseJudgeResponse`'tan geçti. Yargılar `bench/cache/judge.jsonl`'da `claude-sonnet-agent:` anahtarıyla duruyor.
- **Araç:** `--prompt-lang`, `--skills-dir`, `--dump-judge-prompts`, `bench/import-judgments.ts`, `--judge-cache-only` (`15a04a1`).

## Sonuçlar

| Metrik | tr / kapalı | en / kapalı | tr / açık | en / açık |
|---|---|---|---|---|
| Correctness (cevaplı, n=33) | 3,76 | 3,73 | 3,76 | 3,73 |
| Correctness ≥4 payı | 0,61 | 0,58 | 0,58 | 0,58 |
| Relevance (n=40) | 4,18 | 4,10 | 4,15 | 4,15 |
| Faithfulness | 0,74 | 0,71 | 0,68 | 0,69 |
| Citation recall | 0,87 | 0,83 | 0,82 | 0,85 |
| Halüsinasyon oranı (cevaplı) | 0,27 | 0,39 | 0,45 | 0,36 |
| Abstention (cevapsız, n=4) | 0/4 | 0/4 | 0/4 | 0/4 |
| Cevap dili uyumu | 1,00 | 1,00 | 0,97 | 0,97 |
| Ortalama cevap uzunluğu (karakter) | 1793 | 1588 | 2376 | 2430 |
| Ortalama üretim süresi | 32,0 sn | 29,7 sn | 49,8 sn | 53,2 sn |
| Ortalama istem tokeni | 2512 | 2381 | 3948 | 3386 |

Güven aralıkları geniş. Correctness'in %95 aralığı her hücrede yaklaşık ±0,35.

**Eşli karşılaştırma** (aynı 33 cevaplı soru, correctness farkı, iki yönlü işaret testi):

| Karşılaştırma | Ortalama fark | Kazanç / kayıp / eşit | p |
|---|---|---|---|
| en/kapalı − tr/kapalı | −0,03 | 7 / 8 / 18 | 1,00 |
| tr/açık − tr/kapalı | 0,00 | 6 / 6 / 21 | 1,00 |
| en/açık − en/kapalı | 0,00 | 5 / 6 / 22 | 1,00 |
| en/açık − tr/açık | −0,03 | 8 / 10 / 15 | 0,81 |

Yalnız TR sorularda (n=21) İngilizce istem +0,05, yalnız EN sorularda (n=12) −0,17. İkisi de anlamsız. Yani İngilizce istem, İngilizce soruda bile yardımcı olmuyor.

## Yorum

- **İstem dili:** Hipotez (Türkçe talimat qwen3:8b'yi zorluyor) desteklenmedi. İngilizce istem ~130 token kısaltıyor ve cevabı biraz kısaltıyor, ama doğruluk, alaka ve kaynak sadakati değişmiyor. İngilizce hücrede halüsinasyon oranı 0,27 → 0,39 çıktı. n=33'te bu 4 cevaplık fark, anlamlı değil. Üretimde Türkçe istem kalıyor, `promptLanguage` yalnız deney için.
- **educational-agent:** Doğruluğa etkisi sıfır. Bedeli ölçülebilir: istem +1000–1400 token, üretim süresi +%55–80, cevap +%35. Faithfulness biraz düşük, halüsinasyon biraz yüksek, ama bunlar da anlamlı değil. Skill'in asıl iddiası (öğretici davranış, kontrol sorusu, hatayı onaylamama) bu altın setin ölçtüğü şey değil. Bu set tek turlu bilgi soruları içeriyor. Kontrol sorusuyla biten cevap 40'ta 2, "BİLİNEN / BİLİNMEYEN" biçimi hiç kullanılmadı (cevapsız 4 soruda bile).
- **Çekimserlik:** Hiçbir varyant cevapsız soruda "notlarda yok" demedi (0/4). Bu, #29'daki bulguyla aynı. İstemin dili de skill'in "Uydurma yok" kuralı da bunu değiştirmiyor.

## Sınırlar

- 40 soru, her hücrede tek örnek (sıcaklık varsayılan). Küçük etkileri (±0,2) yakalayacak güç yok. Ama doğruluk ortalamalarının hepsi 0,03 içinde, tam sete genişletmek için bir sinyal de yok.
- Yargıç Sonnet. Tam sette DeepSeek'ten yaklaşık 0,1 daha katıydı. Hücreler aynı yargıçla karşılaştırıldığı için bu kayma karşılaştırmayı etkilemiyor.
- Çok turlu öğretme davranışı (skill'in asıl hedefi) ölçülmedi.

## Sonuç dosyaları

`data/vaults/default/bench/results/` altında:

- Cevaplar: `2026-10-21T07-52-17-688Z-ab28-tr-off`, `…T08-14-00-768Z-ab28-en-off`, `…T08-34-05-128Z-ab28-tr-on`, `…T09-07-33-381Z-ab28-en-on`
- Yargılı raporlar: `…-ab28-<varyant>-judged`
