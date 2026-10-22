# Çıktı bozulması ve belirsiz soru, 2026-10-22

İki Öneriler maddesi ölçüldü: qwen3 çıktı bozulmaları ve belirsiz soruda netleştirme.

## 1. Çıktı bozulmaları

**Veri:** 896 cevap: #27 tam koşu (330), reranker alt kümeleri (124), #28 A/B (160), `chats.db`'deki asistan mesajları (282, salt-okunur).

| Bozulma | Bench (614) | Gerçek sohbet (282) | Uygulamada durum |
|---|---|---|---|
| Çince sözcük | 9 | 2 (Ağustos) | Zaten yakalanıyor: `resume-plan.ts` CJK'yı bozulma sayıp temiz önekten devam ettiriyor (`00f87f1`, `a4df215`). Bench bu korumayı bilerek atlıyor, oradaki sayılar uygulamayı yansıtmıyor. |
| Tekrar döngüsü | 4 | 8 (hepsi 2026-09-20) | Yoktu. 4096 token tavanına kadar sürüyordu (12–14 bin karakter). |
| Başıboş `</think>` | 2 (ikisi de döngünün sonunda) | 0 | Yoktu. Model düşünme kapalıyken akıl yürütmeyi düz yazıyor, `</think>` satırından sonra cevaba baştan başlıyor. |

**Algılama kuralı:** Cevabın son 200 karakteri metinde 3. kez görülürse döngü sayılır. Dilden bağımsızdır; `**Özellikler:**` gibi kısa başlıkların meşru tekrarına takılmaz. Denenen ayarlar:

| Kuyruk / tekrar | İsabet |
|---|---|
| 120 / 2 | 33 (çok sayıda meşru tekrar) |
| 120 / 3 | 13 |
| 200 / 2 | 18 |
| **200 / 3** | **12, hepsi bozuk tekrar** |

200/3 ayarında sınırda kalan tek örnek `f2_053`: üç bölüm aynı 200 karakterlik cümleyle başlıyor; yalnız sonuncusu atılıyor.

**Uygulanan:** `8715f15`.
- Döngüde deneme durur, tekrar kırpılır (periyodikse tek kopya kalır), açık kalan kod bloğu kapatılır, tur normal biter.
- Başıboş `</think>` öncesi düşünme bölümüne taşınır.

Akış benzetiminde 12 cevabın hepsi döngü başladıktan kısa süre sonra durdu. Kırpılmış metinlerde döngü kalmadı. 896 cevabın taranması toplam 0,2 sn sürdü.

**Doğrulanmayan:** Rota düzeyinde test yok; gerçek bir döngüyü canlı sohbette tetiklemek denenmedi.

## 2. Belirsiz soru: istem kuralı pilotu

**Kurulum:**
- 15 belirsiz soru, ve parçaları en az iki konu klasöründen gelen 15 net kontrol sorusu (direct/conceptual/cross_document, tohumlu seçim).
- qwen3:8b, geçici Ollama (11435).
- İki varyant: temel ve kurallı. Kural kullanıcı skill'i olarak verildi: "parçalar terimi farklı anlamlarda kullanıyorsa anlamları ayır, sonda hangisini kastettiğini sor; aynı kavramın farklı yönleri belirsizlik değildir".
- 60 cevap karıştırılıp varyant bilgisi olmadan tek Sonnet yargıcına verildi. Yargıcın "belirsiz mi" etiketi altın setle 60/60 uyuştu.

| | anlamları ayırdı | netleştirme sordu | gereksiz bölme/soru | correctness |
|---|---|---|---|---|
| temel, belirsiz | 2/15 | 1/15 | – | 1,80 |
| kurallı, belirsiz | 3/15 | 10/15 | – | 1,93 |
| temel, kontrol | 1/15 | 0/15 | 0/15 | 2,07 |
| kurallı, kontrol | 2/15 | 11/15 | 11/15 | 1,93 |

**Sonuç:** Kural üretime alınmadı.
- qwen3:8b kuralı yalnız sona "hangisini kastettin?" eklemek olarak uyguluyor; anlamları ayırmıyor.
- Aynı soruyu net kontrol sorularının 11/15'ine de ekliyor.
- Doğruluk iki grupta da değişmiyor: eşli karşılaştırmada belirsizde 2 iyi / 1 kötü, kontrolde 1 iyi / 2 kötü.
- Bu yargıcın puanları #27'deki yargıdan düşük; mutlak değerler değil, varyant farkı anlamlı.

**Retrieval sinyali:** Parçaların kaç konu klasöründen geldiği (`wiki/os`, `wiki/embedded`…), 330'luk koşudan:

| Eşik | Belirsiz sorular | Normal cevaplı sorular |
|---|---|---|
| ≥ 2 klasör | %87 | ~%47 |
| ≥ 3 klasör | %53 | ~%12 |

Bu sinyal modele "netleştir" dedirtmek için fazla gürültülü. Uygulama tarafında yumuşak bir öneri için kullanılabilir: cevabın altında "Notlarda farklı bağlamlar var: os · embedded · db" çipi, tıklayınca soru o klasörle sınırlanır. Bu, 8B modelin talimat izlemesine dayanmaz. Ölçülmedi, karar kullanıcıda.

**Dosyalar:**
- Cevaplar: `data/vaults/default/bench/results/2026-10-22T09-53-52-675Z-amb-base`, `…10-25-33-924Z-amb-rule`.
- Yargılar, anahtar ve skill: oturumun geçici klasöründe; depoya alınmadı.
