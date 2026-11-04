# squad-engine

Ядро баллистики Squad на Rust для SquadCalc. English version: [README.md](README.md).

* **Решатель** (`flight`, `weapon`): замкнутые формулы в `f64` для обеих дуг, фаз ускорителя
  (ConstantAcceleration), ограничения `MaxSpeed`, смещений дула и пределов возвышения. Построчный перенос
  `src/js/squadBallistics.js` и `src/js/squadFiringSolution.js`; тест паритета запускает настоящие JS-классы.
* **Сегменты траектории** (`path`): полёт в виде прямых отрезков, вершины которых лежат точно на траектории.
* **BVH** (`bvh`): построение binned SAH, развёртка в формат со skip-указателями (ниже), импорт и экспорт `bvh.bin`.
* **Запросы** (`trace`): Мёллер-Трумбор отрезок/треугольник в `f64` (эталон) и `f32` (паритет с GPU, опционально
  SIMD128), безстековый обход (первое попадание), проверка линии огня по всей траектории.
* **Карта высот** (`heightmap`): сэмплер 16-битных G16 с правилом диагонали треугольников как в игре.
* **JSON-интерфейс** (`io`), CLI (`squad-cli`) и wasm-экспорт (`wasm`, feature `wasm`) с ES-обёрткой в `js/`.

Система координат движка: метры, **X на восток, Y на север, Z вверх**. Азимут отсчитывается по часовой стрелке от
севера (`atan2(dX, dY)`). В Unreal ось Y направлена на юг: переведите координаты до построения BVH и до вызова.

## Формат BVH (`bvh.bin`)

Формат является контрактом с WGSL-обходом. Все числа little endian.

```
bvh.bin
  u32 node_count
  u32 tri_count
  node[node_count]       по 32 байта
  triangle[tri_count]    по 48 байт

узел (32 байта)                          треугольник (48 байт) = 3 x vec4<f32>
  смещ.  0  f32 min.x                      смещ.  0  f32 x0, y0, z0, 0   вершина 0
         4  f32 min.y                             16  f32 x1, y1, z1, 0   вершина 1
         8  f32 min.z                             32  f32 x2, y2, z2, 0   вершина 2
        12  u32 a
        16  f32 max.x
        20  f32 max.y
        24  f32 max.z
        28  u32 b
```

* Узлы идут в порядке обхода в глубину. Первый потомок внутреннего узла - следующий (`index + 1`), правый потомок
  находится по escape-индексу левого.
* `a` - **escape-индекс**: куда идти, если луч не попал в коробку узла или поддерево закончилось. `0xFFFFFFFF` -
  конец обхода. Для узла `i` это всегда `i + размер_поддерева(i)` (у листа `i + 1`), а `0xFFFFFFFF`, если результат
  равен `node_count`. У корня `0xFFFFFFFF`.
* `b` у **листа** равно `(first_triangle << 8) | triangle_count` (`1..=255` треугольников), у **внутреннего** узла
  равно `0`. Лист определяется условием `(b & 0xFF) != 0`.
* Треугольники хранятся в порядке листьев: лист `L` владеет `triangles[first_triangle .. first_triangle + count]`.
* Пустая иерархия: `node_count = 0`, `tri_count = 0` (8 байт).

Безстековый обход:

```
i = 0
while i != 0xFFFFFFFF:
    node = nodes[i]
    if луч попал в коробку узла (t in [0, t_max]):
        if node.b & 0xFF:                       # лист
            проверить треугольники node.b >> 8 .. + (node.b & 0xFF); при попадании уменьшить t_max
            i = node.a
        else:
            i = i + 1                           # в первого потомка
    else:
        i = node.a
```

**Ограничение: 2^24 треугольников на один `bvh.bin`.** `first_triangle << 8` должно помещаться в `u32`, поэтому
один файл адресует не более 16 777 216 треугольников. `BvhSet` делит большую выборку по пространству (медиана по
длиннейшей оси центроидов) на несколько иерархий именно такого формата (`bvh_000.bin`, ...); их коробки могут
перекрываться, запрос обходит все части, в корневую коробку которых входит луч. 72 098 154 треугольника Фаллуджи
превращаются в 8 частей. Один такой `bvh.bin` потребовал бы ещё 3,5 ГБ под треугольники, что выше стандартного
`maxStorageBufferBindingSize` в WebGPU.

Углы коробок - точные `f32`-координаты вершин (без запаса); `f64`-запрос расширяет коробки на 1e-6 м. Лист содержит
до 4 треугольников, если дальнейшее деление не выгодно по SAH (16 корзин на ось, стоимость обхода 1, стоимость
треугольника 1); при числе больше 255 деление обязательно.

## JSON-интерфейс

Запрос:

```json
{
  "weapon_specs": { "v0": 110.0, "mass": 4.1, "drag_coef": 0.47 },
  "pos_gun": [0.0, 0.0],
  "pos_target": [0.0, 600.0, 0.0],
  "environment": { "z_scale": 100.0, "heightmap_ref": "map.png", "bvh_buffer_ref": "bvh.bin" }
}
```

Ответ:

```json
{
  "firing_solution": { "azimuth_deg": 0.0, "elevation_mrad": 253.7 },
  "flight_data": { "time_sec": 5.63, "max_ordinate_meters": 38.9 },
  "occlusion_status": "clear",
  "collision_details": { "point": [0.0, 600.0, 0.0], "material": "unknown", "lethality": 1.0, "splash_footprint_radius": 0.0 }
}
```

* `drag_coef` (и `mass`) **принимаются и игнорируются**: снаряды Squad летят в вакууме, `g = 9.80 *
  ProjectileGravityScale`, без сопротивления.
* `pos_gun` - `[X, Y]`, высота орудия берётся из карты высот в этой точке (без карты 0). `pos_target` -
  `[X, Y, Z]`. `azimuth_deg` лежит в `[0, 360)`.
* `environment.z_scale` - половина диапазона высот карты: `Z = (v / 65535 * 2 - 1) * z_scale` для 16-битного
  отсчёта `v`. `heightmap_ref` и `bvh_buffer_ref` - имена ресурсов, загруженных хостом (CLI считает их путями к
  файлам: `.png` 16-бит grayscale или сырой `.g16` для карты; `bvh.bin` или каталог частей `*.bin` для BVH). Оба
  необязательны: без карты земля на Z = 0, без BVH линия огня не проверяется на препятствия.
  `environment.heightmap_resolution_m` (по умолчанию 1) - шаг отсчётов для CLI.
* Сетка карты: строка 0 - северный край, `X = col * resolution`, `Y = -row * resolution` (`lng` и `-lat` в
  SquadCalc). Каждый квадрат делится на два треугольника по диагонали `(row, col)` - `(row + 1, col + 1)`, как в
  `src/js/squadHeightmaps.js`; точка дальше чем на полотсчёта за сеткой имеет высоту 0. Сырой `.g16`: `u32` ширина,
  `u32` высота, затем `u16` отсчёты little endian, строка 0 первой.
* `elevation_mrad` - возвышение прицела в миллирадианах (как `elevation_rad` решателя, умноженное на 1000). `null` и `occlusion_status: "no_solution"` - цель недостижима.
* `occlusion_status`: `clear`, `occluded` (путь встречает треугольник BVH или рельеф до цели; рельеф проверяется
  с шагом карты, по 3 м у обоих концов не учитываются, как в SquadCalc), `unchecked` (нет ни карты, ни BVH),
  `no_solution`.
* `collision_details.point` - первое препятствие на пути, а при чистой линии огня - цель.
* **`material`, `lethality` и `splash_footprint_radius` - заглушка** (`materials.rs`): данные о семантике столкновений
  ещё не переданы, поэтому любая поверхность `"unknown"`, летальность `1.0`, радиус пятна `0.0` м. Точка вызова уже
  получает попавший треугольник; менять нужно только `materials::lookup`.
* Дополнительно: `weapon_specs.model` (ускоритель, `max_speed`, дуло, пределы возвышения, см. `weapon::Weapon`; его
  `velocity` заменяется на `v0`) и `options` (`arc`: `auto` | `low` | `high`, по умолчанию `auto` - нижняя дуга,
  если орудие может её дать; `tolerance_m`: допуск сегментов, по умолчанию 0.05).

CLI: `cargo run --release --bin squad-cli -- request.json` (или запрос в stdin) печатает ответ.

## Сборка и тесты

Тулчейн зафиксирован в `rust-toolchain.toml` (ставится `rustup` на пользователя, без sudo).

```sh
cargo fmt --check
cargo clippy --all-targets --features threads -- -D warnings
cargo test --release --features threads            # модульные, CLI, случайный BVH, паритет с JS-решателем
```

`tests/parity.rs` запускает под Node `tools/js/reference.mjs` (настоящие `Weapon` и `SquadFiringSolution` этого
checkout с заглушками из `tools/direct_fire`) на сетке `tools/direct_fire/compare.py` - 143 снаряда, 15 дальностей x
9 высот плюс 18 случаев у максимальной дальности - и сравнивает обе дуги, угол прицела, оба времени полёта, время
удержания и максимальную дальность. Допуск: 1e-9 градуса для углов, 1e-9 с для времени; для полётов дольше 10 с
допуск относительный 3e-10 (почти вертикальные высокие дуги близких целей, где время меняется примерно на 5e3 с на
радиан, а `sin`/`cos` двух libm различаются в последнем бите).

### BVH против точного трассировщика на Фаллудже

```sh
# 1. треугольники, блокирующие канал Projectile -> сырые байты (docker-образ с numpy, см. tools/docker)
docker build -q -t sc-engine-py tools/docker
docker run --rm --user $(id -u):$(id -g) -v ~/data/volumetric:/data:ro -v ~/work/engine-data:/out \
  -v $PWD/tools:/tools:ro sc-engine-py python3 -I /tools/npz_to_bin.py /data/fallujah_tris.npz /out/fallujah_proj.bin --bits 2
# 2. 100 000 случайных отрезков и первое попадание по tools/volumetric/py/reference.py
docker run --rm --user $(id -u):$(id -g) -e HOME=/tmp -v ~/agl/tools/volumetric/py:/ref:ro -v ~/work/engine-data:/out \
  -v $PWD/tools:/tools:ro sc-engine-py python3 -I /tools/make_segments.py /ref /out/fallujah_proj.bin /out/fallujah --count 100000
# 3. тест и бенчмарк
ENGINE_FALLUJAH_DIR=~/work/engine-data cargo test --release --features threads --test fallujah -- --ignored --nocapture
cargo run --release --features threads --example bench -- ~/work/engine-data/fallujah_proj.bin ~/work/engine-data/fallujah.segments.f64
```

### Результаты (Фаллуджа, 72 098 154 треугольника, 100 000 отрезков, 29 947 попаданий)

```
loaded 72098154 triangles in 4.0 s
built 8 hierarchies, 69699116 nodes, 72098154 triangles in 67.2 s
100000 segments traced in 0.04 s (2343517 segments/s)
hit/no-hit disagreements: 0; segments both hit: 29947; worst hit point difference: 3.9e-13 m
test bvh_agrees_with_the_reference_tracer_on_fallujah ... ok
```

Бенчмарк (`examples/bench.rs`, 8 иерархий: 2230 МБ узлов и 3461 МБ треугольников; машина была общей и загруженной,
пропускную способность читайте как нижнюю оценку):

| | время | отрезков/с |
|---|---|---|
| сборка BVH (binned SAH, все потоки) | 66,3 с | |
| `f64`, первое попадание, все потоки | 0,046 с | 2 163 790 |
| `f64`, первое попадание, 1 поток | 0,186 с | 536 697 |
| `f32`, первое попадание, 1 поток (арифметика GPU) | 0,157 с | 638 749 |

**Про эталон.** Штатный `TriangleIndex.tiles_on` в `reference.py` берёт точки отрезка через 2 м над плитками 8 м и
пропускает плитки, которых отрезок касается только углом. На штатном сэмплере 21 из 100 000 отрезков расходились с
BVH: у 6 эталон не нашёл попадания, у 15 назвал более позднее. Для каждого из 21 первое попадание пересчитано по
формулам Мёллера-Трумбора самого эталона по *всем* треугольникам, чьи коробки пересекают коробку отрезка
(`tools/recheck_expected.py`, чистый numpy); все 21 совпали с результатом BVH до последней цифры (разность `t` меньше
1e-15). `tools/make_segments.py` теперь берёт все плитки габаритной коробки отрезка, так что новая генерация
таких промахов не даёт; поставляемый набор исправлен утилитой пересчёта (отличие от полной перегенерации только в
этих записях). BVH с точным ответом не расходился ни разу.

## WebAssembly

```sh
cargo install wasm-bindgen-cli --version 0.2.130 --locked    # один раз
sh js/build.sh        # js/pkg (обычная) и js/pkg-simd (SIMD128-проверка треугольников)
node --test js/test/  # загружает wasm в Node
```

`js/index.mjs` - ES-обёртка (`loadEngine`, `Engine.solve`, `loadBvh`, `loadHeightmap`, `firstHit`, `buildBvh`,
`segmentTriangle`). SIMD128-сборка - тот же код с `-C target-feature=+simd128` и feature `simd`; тест в Node проверяет,
что она даёт те же `f32`-результаты бит в бит, что и скалярная.

Потоки: feature `threads` включает rayon (параллельная сборка BVH и пакетные запросы) в нативной сборке. В браузере
нужны `SharedArrayBuffer`, то есть cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin` и
`Cross-Origin-Embedder-Policy: require-corp`, настраивает владелец сайта), и feature `wasm-threads`
(`wasm-bindgen-rayon`), для которой нужен nightly с atomics и `-Z build-std`; такая сборка **не входит в закреплённый
stable-тулчейн и здесь не собиралась и не запускалась**.

## Замечания к модели

* Сегменты траектории не интегрируются: каждая вершина считается по точной формуле полёта (парабола, ускоритель
  вдоль оси, ограниченный участок, либо 20-мс подшаги игры для ускорителя вдоль траектории, как в JS), участок
  делится, пока его середина не окажется в пределах `tolerance_m` от хорды. Апекс всегда вершина. Допуск проверяется
  в середине каждого участка после первого деления на 8 равных частей.
* Запрос повторяет `reference.py`: отрезок `p0 + t (p1 - p0)`, `t` из `[0, 1]`, попадание на рёбрах и с любой
  стороны; отрезок с `|det| <= 1e-12` параллелен и промахивается.
