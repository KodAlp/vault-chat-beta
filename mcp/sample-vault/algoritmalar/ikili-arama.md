---
title: İkili arama
domain: algoritmalar
level: undergraduate
source_file: sample/ikili-arama.md
converted_by: sample-vault
---

# İkili arama

## Fikir

İkili arama (binary search), **sıralı** bir dizide bir değeri bulmak için her adımda arama aralığını yarıya indirir. Ortadaki elemanla hedefi karşılaştırırız: hedef ortadakinden küçükse sol yarıda, büyükse sağ yarıda aramaya devam ederiz.

Dizi sıralı değilse algoritma doğru çalışmaz. Önce sıralamak gerekir.

## Gerçekleme

Aşağıdaki Python işlevi, hedefin dizideki indeksini döndürür; bulunamazsa `-1` döndürür.

```python
def ikili_arama(dizi, hedef):
    sol, sag = 0, len(dizi) - 1
    while sol <= sag:
        orta = sol + (sag - sol) // 2
        if dizi[orta] == hedef:
            return orta
        if dizi[orta] < hedef:
            sol = orta + 1
        else:
            sag = orta - 1
    return -1

print(ikili_arama([2, 5, 8, 12, 16, 23, 38], 23))  # 5
```

`orta = sol + (sag - sol) // 2` biçimi, sabit genişlikli tamsayı kullanan dillerde `(sol + sag) // 2` ifadesindeki taşma riskini önler. Python'da tamsayılar sınırsızdır ama bu alışkanlık başka dillere taşınır.

## Karmaşıklık

Her adımda aralık yarıya indiği için $n$ elemanlı bir dizide en fazla yaklaşık $\log_2 n$ adım gerekir. Zaman karmaşıklığı $O(\log n)$, ek bellek kullanımı $O(1)$'dir.

Somut bir sayı: 1.000.000 elemanlı bir dizide en fazla 20 karşılaştırma yeter, çünkü $2^{20} = 1\,048\,576 > 10^6$. Doğrusal arama ise en kötü durumda milyon adım yapar.

## Sık yapılan hatalar

- Döngü koşulunu `sol < sag` yazıp tek elemanlı aralığı atlamak.
- `sol = orta` veya `sag = orta` yazarak aralığı küçültmemek ve sonsuz döngüye girmek; doğrusu `orta + 1` ve `orta - 1`.
- Tekrarlı elemanlarda "hangi indeksi" döndürdüğünü belirlememek. İlk ya da son geçtiği yeri bulmak için bulunca durmak yerine aramaya sola ya da sağa devam etmek gerekir.
