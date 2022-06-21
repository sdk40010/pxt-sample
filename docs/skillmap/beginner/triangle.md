# 直角二等辺三角形

### @explicitHints true
### @diffs true

## チュートリアル2 @showdialog
いろんな大きさの直角二等辺三角形を描いてみましょう。

## 
![triangle](static/skillmap/beginner/triangle.png)
直角二等辺三角形は3辺の比が**1:1:√2**で、3つの角のうち2つの角が**45°**の三角形です。まずは、1つ目の辺を描いていきます。

- :check:
``||turtle:forward||``で**1歩**前進させ、``||turtle:turn right||``で**135°**回転させてください。
辺を描く順番にもよりますが、今回の場合は45°の角を作るために、180° - 45° = 135°回転させる必要があります。

```blocks
turtle.forward(1)
turtle.turnRight(135)
```

## 
- :check:
``||turtle:forward||``で**√2歩**前進させてください。**√2**を計算するには、``||math:squere root||``を使います。

- :check:
``||turtle:turn right||``で**135°**回転させ、``||turtle:forward||``で**1歩**前進させてください。

```blocks
turtle.forward(1)
turtle.turnRight(135)
turtle.forward(Math.sqrt(2))
turtle.turnRight(135)
turtle.forward(1)
```

## 
一度シミュレータを実行してみましょう。ですが、今のままでは小さすぎて見えません。
そこで、三角形を拡大する処理を追加していきます。

- :check:
``||Variables||``をクリックし、**scale**という名前の変数を作り、その変数に**100**を代入してください。
変数は値を入れるための名前のついた箱のような機能を持っています。そして、変数に値を入れることを代入といいます。

```blocks
// @highlight
let scale = 100;
turtle.forward(1)
turtle.turnRight(135)
turtle.forward(Math.sqrt(2))
turtle.turnRight(135)
turtle.forward(1)
```

## 
- :check:
``||math:() × ()||``で各``||turtle:forward||``の歩数に``||variables:scale||``をかけてください。


```blocks
let scale = 100;
turtle.forward(1 * scale)
turtle.turnRight(135)
turtle.forward(Math.sqrt(2) * scale)
turtle.turnRight(135)
turtle.forward(1 * scale)
```

これで100倍に拡大した三角形を描けるようになりました。

## 
``||variables:scale||``に定数ではなく、ランダムな数値を入れて、実行するたびに三角形の大きさが変わるようにしてみましょう。

- :check:
``||math:pick random||``に**100**と**200**を設定し、その計算結果を``||variables:scale||``を代入してください。
``||math:pick random||``は指定した範囲内の整数をランダムに選んで、その値を返してくれます。

- :check:


```blocks
// @highlight
let scale = randint(100, 200);
turtle.forward(1 * scale)
turtle.turnRight(135)
turtle.forward(Math.sqrt(2) * scale)
turtle.turnRight(135)
turtle.forward(1 * scale)
```

## 
- :check:
``||turtle:setSpeed||``で描画速度を最速にしてください。
何度かシミュレータを実行し、実行するたびに三角形の大きさが変わっていることを確認してみましょう。

```blocks
// @highlight
turtle.setSpeed(Speed.Fastest)
let scale = randint(100, 200);
turtle.forward(1 * scale)
turtle.turnRight(135)
turtle.forward(Math.sqrt(2) * scale)
turtle.turnRight(135)
turtle.forward(1 * scale)
```

## 
おめでとうございます！
2つ目のチュートリアルをクリアしました。
