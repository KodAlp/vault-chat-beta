---
title: Türev ve zincir kuralı
domain: matematik
level: undergraduate
source_file: sample/turev-ve-zincir-kurali.md
converted_by: sample-vault
---

# Türev ve zincir kuralı

## Türevin tanımı

Bir $f$ fonksiyonunun $x$ noktasındaki türevi, ortalama değişim hızının limitidir:

$$f'(x) = \lim_{h \to 0} \frac{f(x+h) - f(x)}{h}$$

Geometrik olarak $f'(x)$, grafiğin o noktadaki teğetinin eğimidir. Limit yoksa fonksiyon o noktada türevlenemez; örneğin $|x|$ fonksiyonu $x = 0$ noktasında türevlenemez.

## Temel türev kuralları

- Sabit: $\frac{d}{dx} c = 0$
- Kuvvet: $\frac{d}{dx} x^n = n x^{n-1}$
- Toplam: $(f + g)' = f' + g'$
- Çarpım: $(fg)' = f'g + fg'$
- Bölüm: $\left(\frac{f}{g}\right)' = \frac{f'g - fg'}{g^2}$, $g \neq 0$
- Üstel ve trigonometrik: $(e^x)' = e^x$, $(\sin x)' = \cos x$, $(\cos x)' = -\sin x$

## Zincir kuralı

Bileşke bir fonksiyon $y = f(g(x))$ için türev, dıştaki fonksiyonun türevinin içteki fonksiyonun türeviyle çarpımıdır:

$$\frac{d}{dx} f(g(x)) = f'(g(x)) \cdot g'(x)$$

Leibniz gösterimiyle, $y = f(u)$ ve $u = g(x)$ olsun:

$$\frac{dy}{dx} = \frac{dy}{du} \cdot \frac{du}{dx}$$

Pratik yöntem: önce dıştaki fonksiyonu türet ve içtekini olduğu gibi bırak, sonra içtekinin türeviyle çarp.

## Çözümlü örnek

$f(x) = (3x^2 + 1)^4$ fonksiyonunun türevini bulalım.

1. Dış fonksiyon $u^4$, iç fonksiyon $u = 3x^2 + 1$.
2. $\frac{dy}{du} = 4u^3$ ve $\frac{du}{dx} = 6x$.
3. Çarpınca:

$$f'(x) = 4(3x^2 + 1)^3 \cdot 6x = 24x(3x^2 + 1)^3$$

Kontrol: $x = 0$ için $f'(0) = 0$. Fonksiyon $x = 0$ noktasında $f(0) = 1$ değerini alır ve $3x^2 + 1 \geq 1$ olduğundan orada yerel minimum vardır; teğet yataydır.

## Birden fazla katman

Zincir kuralı iç içe daha fazla fonksiyona genişler. $y = \sin(x^2)$ için $u = x^2$ alınırsa $y' = \cos(x^2) \cdot 2x$ bulunur. $y = e^{\sin x}$ için ise $y' = e^{\sin x} \cos x$ olur.

Sık yapılan hata, iç fonksiyonun türevini çarpmayı unutmaktır: $(\sin 2x)' = 2\cos 2x$, yalnızca $\cos 2x$ değildir.
