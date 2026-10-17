---
title: Vault Chat MCP araçları
domain: vault-chat
level: undergraduate
source_file: sample/vault-chat-mcp-araclari.md
converted_by: sample-vault
---

# Vault Chat MCP araçları

## Genel bakış

Vault Chat'in MCP sunucusu, kasandaki notları Claude gibi MCP istemcilerine açar. Bu örnek kasa ("Örnek Kasa"), araçları hemen denemen için kuruldu. Bir kasa istemciye ancak **MCP'ye açık** işaretliyse görünür; örnek kasa bu şekilde oluşturulur.

## Okuma araçları

- `list_vaults`: MCP'ye açık kasaları listeler; her kasanın indekslenip indekslenmediğini de gösterir.
- `search_library`: kasada arar. Varsayılan modda vektör araması yapar, gömme (embedding) sunucusu yoksa anahtar kelime (FTS5) aramasına düşer. `domain` ve `level` ile daraltılabilir.
- `get_note`: bir notu okur. `heading` verirsen yalnızca o başlığın bölümü gelir; uzun notlar `max_chars` ve `offset` ile sayfa sayfa okunur.
- `list_domains`: kasadaki domain değerlerini, not sayılarıyla listeler.
- `list_sources`: kasadaki kaynakları domain ve seviyeleriyle listeler.

## Denenecek istemler

Örnek kasada beş not var: türev, ikili arama, Ohm yasası, Bayes teoremi ve bu not.

- "Örnek Kasa'da zincir kuralını ara ve çözümlü örneği göster."
- "İkili aramanın zaman karmaşıklığı neden logaritmik? Kasadaki nota göre anlat."
- "Dirençlerin paralel bağlanmasıyla ilgili notu getir, yalnızca çözümlü örnek bölümünü oku."
- "Bayes teoremi notunda tıbbi test örneğinin sonucu nedir?" (not İngilizce; soruyu Türkçe sorsan da bulması gerekir)
- "Kasamdaki domain'leri listele."

## Çapraz dil araması

Bayes notu İngilizce, diğerleri Türkçe. Vektör araması anlam üzerinden eşleştiği için Türkçe bir soru İngilizce notu bulabilir. Yalnızca anahtar kelime aramasında ise sözcükler eşleşmek zorundadır; bu fark, `search_library`'nin `mode` parametresini denerken görülebilir.

## Sonraki adım

Kendi notlarını Vault Chat uygulamasından içe aktar ve kasayı MCP'ye aç (Ayarlar, Kasalar). İstersen örnek kasayı uygulamadan silebilirsin; istemci yapılandırmasına dokunmaz.
