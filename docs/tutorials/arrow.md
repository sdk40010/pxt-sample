# Arrow

### @explicitHints true
### @diffs true

## チュートリアル1 @showdialog
矢印を描いて見ましょう。

## 

``||turtle:forward||``で亀を**100**歩前進させてください。
移動すると線を引くことができます。


```blocks
turtle.forward(100)
```

ブロックを追加したら動作を確認してみましょう。
画面右下にあるシミュレータをクリックして拡大し、スタートボタンを押してください。

今後の手順でも適宜シミュレータを実行してみてください。


## 
``||turtle:turn right||``で右向きに**150**度回転させ、**50**歩前進させてください。


```blocks
turtle.forward(100)
turtle.turnRight(150)
turtle.forward(50)
```

## 
``||turtle:backward||``で後ろ向きに**50歩**移動させてください。

```blocks
turtle.forward(100)
turtle.turnRight(150)
turtle.forward(50)
turtle.backward(50)
```

## 
``||turtle:turn right||``で右向きに**60**度回転させ、``||turtle:forward||``で**50**歩前進させてください。

```blocks
turtle.forward(100)
turtle.turnRight(150)
turtle.forward(50)
turtle.backward(50)
turtle.turnRight(60)
turtle.forward(50)
```

## 
ここまでの手順で矢印が描けているはずです。
今は矢印の色は赤色ですが、``||turtle:set pen color||``で色を変えることができます。
好きな色に変えてみてください。


```blocks
// @highlight
turtle.setPenColor(0x007fff)
turtle.forward(100)
turtle.turnRight(150)
turtle.forward(50)
turtle.backward(50)
turtle.turnRight(60)
turtle.forward(50)
```

## 
``||turtle:set pen size||``で線の太さを変えることもできます。

```blocks
turtle.setPenColor(0x007fff)
// @highlight
turtle.setPenSize(10)
turtle.forward(100)
turtle.turnRight(150)
turtle.forward(50)
turtle.backward(50)
turtle.turnRight(60)
turtle.forward(50)
```

## 
``||turtle:set speed||``で移動速度を変えることもできます。
**slow**, **normal**, **fast**, **fastest**の4段階で調整できます。

```blocks
turtle.setPenColor(0x007fff)
turtle.setPenSize(10)
// @highlight
turtle.setSpeed(Speed.Fast)
turtle.forward(100)
turtle.turnRight(150)
turtle.forward(50)
turtle.backward(50)
turtle.turnRight(60)
turtle.forward(50)
```

## 
今回でここで終わりです。
次のチュートリアルに進みましょう。