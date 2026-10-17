---
title: Ohm yasası, seri ve paralel dirençler
domain: elektronik
level: undergraduate
source_file: sample/ohm-yasasi-seri-paralel-direncler.md
converted_by: sample-vault
---

# Ohm yasası, seri ve paralel dirençler

## Ohm yasası

Bir direncin uçlarındaki gerilim, üzerinden geçen akımla orantılıdır:

$$V = I R$$

Burada $V$ volt, $I$ amper ve $R$ ohm ($\Omega$) birimindedir. Direncin harcadığı güç:

$$P = V I = I^2 R = \frac{V^2}{R}$$

## Seri bağlantı

Dirençler uç uca bağlanırsa hepsinden **aynı akım** geçer, gerilimler paylaşılır. Eşdeğer direnç toplamdır:

$$R_{s} = R_1 + R_2 + \dots + R_n$$

Her direncin gerilimi, direnç oranıyla bölünür (gerilim bölücü): $V_k = V \cdot \frac{R_k}{R_s}$.

## Paralel bağlantı

Dirençlerin uçları ortak düğümlere bağlanırsa hepsinin **gerilimi aynıdır**, akım kolların arasında paylaşılır:

$$\frac{1}{R_{p}} = \frac{1}{R_1} + \frac{1}{R_2} + \dots + \frac{1}{R_n}$$

İki direnç için kısa form: $R_p = \frac{R_1 R_2}{R_1 + R_2}$. Paralel eşdeğer direnç her zaman en küçük dirençten de küçüktür.

## Çözümlü örnek

12 V'luk bir kaynağa $R_1 = 100\ \Omega$ direnci bağlıdır; ona seri olarak, birbirine paralel iki direnç eklenmiştir: $R_2 = 60\ \Omega$ ve $R_3 = 30\ \Omega$.

1. Paralel grup: $\frac{1}{R_p} = \frac{1}{60} + \frac{1}{30} = \frac{3}{60}$, yani $R_p = 20\ \Omega$.
2. Toplam direnç: $R_{top} = 100 + 20 = 120\ \Omega$.
3. Kaynaktan çekilen akım: $I = \frac{12}{120} = 0{,}1\ \text{A}$.
4. $R_1$ üzerindeki gerilim: $0{,}1 \cdot 100 = 10\ \text{V}$; paralel grubun gerilimi $12 - 10 = 2\ \text{V}$.
5. Kol akımları: $I_2 = \frac{2}{60} = \frac{1}{30}\ \text{A}$ ve $I_3 = \frac{2}{30} = \frac{1}{15}\ \text{A}$. Toplamları $\frac{1}{30} + \frac{2}{30} = 0{,}1\ \text{A}$, kaynak akımına eşittir.
6. Toplam güç: $P = 12 \cdot 0{,}1 = 1{,}2\ \text{W}$.

Son adımdaki tutarlılık denetimi (kol akımlarının toplamı = kaynak akımı) çözümü doğrulamak için iyi bir alışkanlıktır.
