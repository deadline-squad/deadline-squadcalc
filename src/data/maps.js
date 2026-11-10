const FOBEXCLUSIONS = {
    small: 300,
    medium: 400,
};

// Layers that play with the 300 m radius on a map whose other layers have 400 m. The game sets the radius per layer:
// `FOBRadius` of the layer's data asset (Gameplay_Layer_Data/<layer>) names a row of DT_FOBExclusionRadius, 01_Small
// (300 m) or the default 02_Medium (400 m); a FOB's construction radius is 150 m in both (Squad build 26005357).
// They are the 28 Skirmish layers of those maps, 9 of their Seed layers and Al Basrah RAAS v3. The mode does not
// decide it: Manicouagan Seed v1 and Seed v2 CL and Pacific Proving Grounds Seed v1 play with 400 m.
// tests/fixtures/gameFobExclusion.json has the radius of each of the game's 221 layers, and tests/maps.test.mjs
// fails when this list is not exactly the 300 m layers of the maps whose `radiusExclusion` is 400.
export const SMALL_FOB_LAYERS = new Set([
    "AlBasrah_RAAS_v3", "AlBasrah_Seed_v1", "AlBasrah_Seed_v2", "AlBasrah_Skirmish_v1", "AlBasrah_Skirmish_v2",
    "AlBasrah_Skirmish_v3", "Anvil_Skirmish_v1", "BlackCoast_Seed_v1", "BlackCoast_Skirmish_v1", "Fallujah_Seed_v1",
    "Fallujah_Skirmish_v1", "Fallujah_Skirmish_v2", "GooseBay_Seed_v1", "GooseBay_Skirmish_v1",
    "Gorodok_Skirmish_v1", "Harju_Seed_v1", "Harju_Skirmish_v1", "Harju_Skirmish_v2", "Kamdesh_Skirmish_v1",
    "Kohat_Skirmish_v1", "Lashkar_Skirmish_v1", "Manicouagan_Skirmish_v1", "Manicouagan_Skirmish_v2",
    "Manicouagan_Skirmish_v3", "Mestia_Skirmish_v1", "Mutaha_Seed_v1", "Mutaha_Skirmish_v1", "Narva_Skirmish_v1",
    "Sanxian_Seed_v1", "Sanxian_Skirmish_v1", "Skorpo_Skirmish_v1", "Tallil_Seed_v1", "Tallil_Skirmish_v1",
    "Tallil_Skirmish_v2", "Tallil_Skirmish_v3", "Yehorivka_Skirmish_v1", "Yehorivka_Skirmish_v1_WP",
    "Yehorivka_Skirmish_v2",
]);

export const MAPS = [
    {   // UE5
        name: "AlBasrah",
        mapURL: "/img/maps/albasrah/",
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                corner0: [-2000, -2000],
                corner1: [2000, 2000],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-2000.0, -2000.0], max: [2000.0, 2000.0] },
            },
            heightmap: {
                origin: [-2040, -2040],
                size: [4081, 4081],
                scale: [1, 1, 1],
                BWlevels: [291, 873],
            },
            heightmapPNG: {
                scale: [1, 1, 0.087813952],
            }
        }
    },
    { 
        name: "Anvil", 
        mapURL: "/img/maps/anvil/",
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                corner0: [-2040, -2040],
                corner1: [1020, 1020],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-2040.0, -2040.0], max: [1020.0, 1020.0] },
            },
            heightmap: {
                origin: [-2040, -2040],
                size: [4081, 4081],
                scale: [0.75, 0.75, 0.45],
                BWlevels: [1825, 6640]
            },
            heightmapPNG: {
                scale: [0.75, 0.75, 0.226426712],
            }
        }
    },
    { 
        name: "BlackCoast", 
        mapURL: "/img/maps/blackcoast/",
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                corner0: [-2299, -2127],
                corner1: [2299, 2472],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-2300.0, -2127.47], max: [2299.98, 2472.51] },
            },
            heightmap: {
                origin: [-2040, -2142],
                size: [4065, 4065],
                scale: [1.003937, 1.003937, 0.8],
                BWlevels: [2593, 7712]
            },
            heightmapPNG: {
                scale: [1.003937, 1.003937, 0.417170742],
            }
        }
    },
    { 
        name: "Chora", 
        mapURL: "/img/maps/chora/",
        radiusExclusion: FOBEXCLUSIONS.small,
        SDK_data: {
            minimap: {
                corner0: [-2464, -2664],
                corner1: [1600, 1400],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-2464.0, -2664.0], max: [1599.9, 1400.0] },
            },
            heightmap: {
                origin: [-2464, -1902],
                size: [8129, 4827],
                scale: [0.5, 0.5, 4],
                BWlevels: [1209, 1369]
            },
            heightmapPNG: {
                scale: [0.5, 0.5, 0.982942589],
            }
        }
    },
    { 
        name: "Fallujah", 
        mapURL: "/img/maps/fallujah/",
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                corner0: [-1315, -1545],
                corner1: [1690, 1460],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-1315.0, -1545.0], max: [1690.0, 1460.0] },
            },
            heightmap: {
                origin: [-2040, -2040],
                size: [4081, 4081],
                scale: [1, 1, 1],
                BWlevels: [39, 440]
            },
            heightmapPNG: {
                scale: [1, 1, 0.14797459],
            }
        }
    },
    { 
        name: "FoolsRoad",
        mapURL: "/img/maps/foolsroad/",
        radiusExclusion: FOBEXCLUSIONS.small,
        SDK_data: {
            minimap: {
                corner0: [-1326, -1326],
                corner1: [448, 448],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-1325.77, -1325.77], max: [448.05, 448.05] },
            },
            heightmap: {
                origin: [-1598, -1866],
                size: [2806, 2806],
                scale: [1, 1, 3.2],
                BWlevels: [0, 675]
            },
            heightmapPNG: {
                scale: [1, 1, 0.20168671],
            }
        }
    },
    { 
        name: "GooseBay", 
        mapURL: "/img/maps/goosebay/",
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                corner0: [-2016, -2016],
                corner1: [2015, 2015],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-2016.58, -2016.75], max: [2015.23, 2015.03] },
            },
            heightmap: {
                origin: [-2032, -2032],
                size: [4065, 4065],
                scale: [1, 1, 0.4],
                BWlevels: [0, 5516]
            },
            heightmapPNG: {
                scale: [1, 1, 0.274412178],
            }
        }
    },
    { 
        name: "Gorodok", 
        mapURL: "/img/maps/gorodok/",
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                corner0: [-2032, -2032],
                corner1: [2032, 2032],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-2031.99, -2032.0], max: [2032.01, 2032.0] },
            },
            heightmap: {
                origin: [-2032, -2032],
                size: [4065, 4065],
                scale: [1, 1, 10],
                BWlevels: [750, 950]
            },
            heightmapPNG: {
                scale: [1, 1, 0.173697718],
            }
        }
    },
    { 
        name: "Harju", 
        mapURL: "/img/maps/harju/",
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                corner0: [-2016, -2016],
                corner1: [2016, 2016],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-2016.0, -2016.0], max: [2016.0, 2016.0] },
            },
            heightmap: {
                origin: [-2016, -2016],
                size: [4033, 4033],
                scale: [1, 1, 1],
                BWlevels: [1349, 3241]
            },
            heightmapPNG: {
                scale: [1, 1, 0.229927482],
            }

        }
    },
    { 
        name: "Jensen", 
        mapURL: "/img/maps/jensen/",
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                corner0: [-2004, -2004],
                corner1: [2004, 2004],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-2004.0, -2004.0], max: [2004.0, 2004.0] },
            },
            heightmap: {
                origin: [-2040, -2040],
                size: [4081, 4081],
                scale: [1, 1, 1],
                BWlevels: [4643, 5595]
            },
            heightmapPNG: {
                scale: [1, 1, 0.185722727],
            }
        }
    },
    { 
        name: "Kamdesh", 
        mapURL: "/img/maps/kamdesh/",
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                corner0: [-2016, -2016],
                corner1: [2016, 2016],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-2016.0, -2016.0], max: [2016.0, 2016.0] },
            },
            heightmap: {
                origin: [-2016, -2016],
                size: [4033, 4033],
                scale: [1, 1, 1.35],
                BWlevels: [5437, 6846]
            },
            heightmapPNG: {
                scale: [1, 1, 0.387570609],
            }
        }
    },
    { 
        name: "Kohat", 
        mapURL: "/img/maps/kohat/",
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                corner0: [-2300, -2300],
                corner1: [2317, 2317],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-2300.0, -2300.0], max: [2317.0, 2317.0] },
            },
            heightmap: {
                origin: [-2016, -2016],
                size: [4065, 4065],
                scale: [1, 1, 0.75],
                BWlevels: [0, 9775]
            },
            heightmapPNG: {
                scale: [1, 1, 0.750167993],
            }
        }
    },
    { 
        name: "Kokan",
        mapURL: "/img/maps/kokan/",
        radiusExclusion: FOBEXCLUSIONS.small,
        SDK_data: {
            minimap: {
                corner0: [-1076, -1076],
                corner1: [1420, 1420],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-1076.35, -1075.67], max: [1420.14, 1420.14] },
            },
            heightmap: {
                origin: [-1333, -1714],
                size: [6097, 7367],
                scale: [0.5, 0.5, 1],
                BWlevels: [100, 264]
            },
            heightmapPNG: {
                scale: [0.5, 0.5, 0.174065564],
            }
        }
    },
    { 
        name: "Lashkar", 
        mapURL: "/img/maps/lashkar/",
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                corner0: [-2167, -2167],
                corner1: [2167, 2167],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-2167.0, -2167.0], max: [2167.0, 2167.0] },
            },
            heightmap: {
                origin: [-2167, -2167],
                size: [4336, 4336],
                scale: [1, 1, 1.5],
                BWlevels: [5006, 6887]
            },
            heightmapPNG: {
                scale: [1, 1, 0.321048558],
            }
        }
    },
    { 
        name: "Logar", 
        mapURL: "/img/maps/logar/",
        radiusExclusion: FOBEXCLUSIONS.small,
        SDK_data: {
            minimap: {
                corner0: [-881, -1132],
                corner1: [880, 629],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-881.45, -1132.39], max: [879.78, 629.22] },
            },
            heightmap: {
                origin: [-1386, -1260],
                size: [2773, 1891],
                scale: [1, 1, 0.5],
                BWlevels: [6188, 8903]
            },
            heightmapPNG: {
                scale: [1, 1, 0.248098348],
            }
        }
    },
    { 
        name: "Manicouagan", 
        mapURL: "/img/maps/manicouagan/",
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                corner0: [-2016, -2016],
                corner1: [2015, 2015],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-2016.58, -2016.75], max: [2015.23, 2015.03] },
            },
            heightmap: {
                origin: [-2032, -2032],
                size: [4065, 4065],
                scale: [1, 1, 3],
                BWlevels: [2479, 5898]
            },
            heightmapPNG: {
                scale: [1, 1, 0.403959641],
            }
        }
    },
    { 
        name: "Mestia", 
        mapURL: "/img/maps/mestia/",
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                corner0: [-1200, -1100],
                corner1: [1200, 1300],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-1200.0, -1100.0], max: [1200.0, 1300.0] },
            },
            heightmap: {
                origin: [-1545, -1162],
                size: [3061, 2551],
                scale: [1, 1, 1.2],
                BWlevels: [2479, 5898]
            },
            heightmapPNG: {
                scale: [1, 1, 0.493831859],
            }
        }
    },
    { 
        name: "Mutaha", 
        mapURL: "/img/maps/mutaha/",
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                corner0: [-935, -1140],
                corner1: [1820, 1615],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-935.0, -1140.0], max: [1820.0, 1615.0] },
            },
            heightmap: {
                origin: [-1785, -1785],
                size: [4081, 4081],
                scale: [1, 1, 0.3],
                BWlevels: [4326, 6683]
            },
            heightmapPNG: {
                scale: [1, 1, 0.112586966],
            }
        }
    },
    { 
        name: "Narva", 
        mapURL: "/img/maps/narva/",
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                corner0: [-1390, -1402],
                corner1: [1410, 1398],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-1389.71, -1402.07], max: [1410.29, 1397.93] },
            },
            heightmap: {
                origin: [-2032, -2032],
                size: [4065, 4065],
                scale: [1, 1, 1],
                BWlevels: [4940, 5523]
            },
            heightmapPNG: {
                scale: [1, 1, 0.205154741],
            }
        }
    },
    // { 
    //     name: "Narva_f", 
    //     mapURL: "/img/maps/narva-flooded/",
    //     radiusExclusion: FOBEXCLUSIONS.medium,
    //     SDK_data: {
    //         minimap: {
    //             corner0: [-1390, -1402],
    //             corner1: [1410, 1398],
    //         },
    //         heightmap: {
    //             origin: [-2016, -2016],
    //             size: [4033, 4033],
    //             scale: [1, 1, 1],
    //             BWlevels: [4940, 5523]
    //         },
    //         heightmapPNG: {
    //             scale: [1, 1, 0.4],
    //         }
    //     }
    // },
    { 
        name: "Pacific", 
        mapURL: "/img/maps/pacific/",
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                corner0: [-2016, -2016],
                corner1: [2016, 2016],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-2016.0, -2016.0], max: [2016.0, 2016.0] },
            },
            heightmap: {
                origin: [-2016, -2016],
                size: [4033, 4033],
                scale: [1, 1, 0.28],
                BWlevels: [410, 9643]
            },
            heightmapPNG: {
                scale: [1, 1, 0.317704444],
            }
        }
    },
    { 
        name: "Sanxian",
        mapURL: "/img/maps/sanxian/",
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                corner0: [-2300, -2050],
                corner1: [2300, 2550],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-2300.0, -2050.0], max: [2300.0, 2550.0] },
            },
            heightmap: {
                origin: [-2040, -2040],
                size: [4081, 4081],
                scale: [1, 1, 1],
                BWlevels: [1349, 3241]
            },
            heightmapPNG: {
                scale: [1, 1, 0.233953671],
            }
        }
    },
    { 
        name: "Skorpo", 
        mapURL: "/img/maps/skorpo/",
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                // The map image spans these corners, 6849 m by 6869 m: its west edge 9.5 m and its east edge 10.5 m west
                // of the game's minimap (`game`), its south edge 0.08 m north of it. Nothing is turned: the game's minimap
                // texture lies on world X and Y within 0.05 degrees, as its compass and map do; only Skorpo's landscape
                // actor is turned (yaw -2.006 degrees), which the heightmaps take in (tools/heightmaps of the deployment
                // repository places each landscape with its actor's transform).
                corner0: [-3611, -3293],
                corner1: [3238, 3576],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-3601.5, -3293.0], max: [3248.5, 3576.08] },
                // The world rectangle the game's texture (the upstream basemap and its HQ tiles) shows, 6868.8 m wide: the
                // texture's edges registered on the level data (objects, crowns and roads, 33 windows of 8 x 8 over the map:
                // within 0.08 m at its edges, 0.24 m at its worst corner) and, independently, its own shading on the ground (34
                // windows: 0.44 and 0.57 m west at the west and east edges, so no scale is left). Its east edge lies 9.2 m east
                // of the game's minimap and 19.7 m east of corner1. The page draws those images over it (mapImages.js), where
                // the world is; the game draws them over its corners, features 9.6 m east of the world at the west edge and
                // 9.2 m west of it at the east edge.
                image: { min: [-3611.1, -3291.8], max: [3257.7, 3575.8] },
            },
            heightmap: {
                origin: [-4138, -2142],
                size: [7113, 5081],
                scale: [1.2, 1.2, 3.5],
                BWlevels: [952, 4074]
            },
            heightmapPNG: {
                scale: [1.2, 1.2, 2.086916336],
            }
        }
    },
    { 
        name: "Sumari", 
        mapURL: "/img/maps/sumari/",
        radiusExclusion: FOBEXCLUSIONS.small,
        SDK_data: {
            minimap: {
                corner0: [-640, -447],
                corner1: [660, 853],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-639.74, -447.28], max: [660.34, 852.97] },
            },
            heightmap: {
                origin: [-682, -372],
                size: [1427, 1055],
                scale: [1, 1, 0.75],
                BWlevels: [1375, 1854]
            },
            heightmapPNG: {
                scale: [1, 1, 0.267739565],
            }
        }
    },
    { 
        name: "Tallil", 
        mapURL: "/img/maps/tallil/",
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                corner0: [-2340, -2340],
                corner1: [2340, 2340],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-2340.0, -2340.0], max: [2340.0, 2340.0] },
            },
            heightmap: {
                origin: [-2286, -2286], // the first landscape components lie 254 m before the actor's location (-2032)
                size: [4573, 4573],
                scale: [1, 1, 1.25],
                BWlevels: [3689, 4111]
            },
            heightmapPNG: {
                scale: [1, 1, 0.152035884],
            }
        }
    },
    { 
        name: "Yehorivka", 
        mapURL: "/img/maps/yehorivka/", 
        radiusExclusion: FOBEXCLUSIONS.medium,
        SDK_data: {
            minimap: {
                corner0: [-3302, -3302], 
                corner1: [3048, 3048],
                // The game's own corners (MapTextureCorner0/1 of the layers' SQWorldSettings, build 26005357), in metres
                game: { min: [-3301.97, -3301.99], max: [3048.03, 3048.0] },
            },
            heightmap: {
                origin: [-3302, -3302], // SDK is wrong, this is deduced instead
                size: [6351, 6351],
                scale: [1, 1, 4],
                BWlevels: [0, 833]
            },
            heightmapPNG: {
                scale: [1, 1, 0.485970247],
            }
        }
    },
    // Custom Map Template
    //   * Create the necessary folders in /public/ and point mapURL to it
    //   * squadcalc will look at the folder looking for basemap.webp, and for its basemap_hq tiles in high quality mode
    // { 
    //     name: `CustomMap #1`,
    //     mapURL: `/img/maps/customMap1/`, 
    //     radiusExclusion: FOBEXCLUSIONS.medium,
    //     SDK_data: {
    //         minimap: {
    //             corner0: [-3302, -3302], 
    //             corner1: [3048, 3048],
    //         },
    //     }
    // },
];


/**
 * Calculates the final z-scaling of a heightmap,
 * by taking the black and white levels used in gimp to optimize the heightmap,
 * and the zScale of the UE4 landscape transform in meters from SquadSDK
 * @param {number} bLevel - optimized black level from original heightmap
 * @param {number} wLevel - optimized white level from original heightmap
 * @param {number} zScale - original zScale of landscape transform in SquadSDK in meters
 * @returns {number} final scaling
 */
function scale(bLevel, wLevel, zScale) {
    const levelRange = (wLevel - bLevel) / 10000;
    return (512 * levelRange * zScale) / 512;
}


/**
 * Generates array with [x,y] dimensions of map, based on the minimap corner transforms from SquadSDK
 * @param {Number[]} fCorner - [x,y] positon of north west corner of minimap in SquadSDK
 * @param {Number[]} sCorner - [x,y] positon of south east corner of minimap in SquadSDK
 * @returns {Number[]} - bounds array with lengths of x and y dimensions of map
 */
function bounds(fCorner, sCorner) {
    // using min and max so that it doesn't matter which corners are used, as long as they are opposite to each other
    const xM = Math.max(fCorner[0], sCorner[0]) - Math.min(fCorner[0], sCorner[0]);
    const yM = Math.max(fCorner[1], sCorner[1]) - Math.min(fCorner[1], sCorner[1]);
    return [xM, yM];
}


/**
 * Utility function to generate information needed to optimize heightmaps.
 * Generates information about scaling and cropping heightmaps so that they match the minimap and map dimensions.
 * Also calculates map dimensions.
 */
function extraInfo() {

    MAPS.forEach((map) => {

        const e = map.SDK_data;
        if (!e) {
            console.warn(`${map.name} has no SDK Data!`);
            return;
        }

        const mm = e.minimap;
        const mmBounds = bounds(mm.corner0, mm.corner1);

        const xO = e.heightmap.origin[0] - Math.min(mm.corner0[0], mm.corner1[0]);
        const yO = e.heightmap.origin[1] - Math.min(mm.corner0[1], mm.corner1[1]);

        // Map info
        console.log(`${map.name}`);
        console.log(`    * Map dimensions: [${mmBounds}]`);
        console.log(`    * Heightmap dimensions : [${e.heightmap.size[0]},${e.heightmap.size[1]}], scale: [${e.heightmap.scale}]`);

        // how to scale & crop heightmap in gimp
        console.log("    * Minimap & Heightmap position :");
        console.log(`        -> scale heightmap to: ${Math.round(e.heightmap.size[0] * e.heightmap.scale[0])}x${Math.round(e.heightmap.size[1] * e.heightmap.scale[1])}`);
        console.log(`        -> set canvas size to: ${mmBounds[0]}x${mmBounds[1]} with offset: ${xO}x${yO}`);

        // Warning if the heightmap is smaller than the minimap
        if (e.heightmap.size[0] * e.heightmap.scale[0] < mmBounds[0] || e.heightmap.size[1] * e.heightmap.scale[1] < mmBounds[1]) {
            console.warn("        -> heightmap is smaller than the minimap");
        }

        // Heightmap z-scaling & levels
        console.log("    * Heightmap z-scaling & Levels :");
        console.log(`        -> set levels to: ${e.heightmap.BWlevels[0]} <-> ${e.heightmap.BWlevels[1]}`);
        console.log(`        -> final z-scale: ${scale(e.heightmap.BWlevels[0], e.heightmap.BWlevels[1], e.heightmap.scale[2])}`);
        console.log("---");
    });

}

// Only run this with `node src/data/maps.js mapinfo`
if (typeof process !== "undefined" && process.argv?.[2] === "mapinfo") {
    extraInfo();
}

/**
 * Where the game's grid starts relative to the map image: the game anchors its A1 corner at the north-west
 * corner of the minimap (MapTextureCorner0/1), which the image extent (`corner0`/`corner1`) can differ from by
 * rounding (under 1 m) or, on Skorpo, by a fitted image (10 m).
 * @param {{corner0: Number[], corner1: Number[], game?: {min: Number[], max: Number[]}}} minimap - SDK_data.minimap
 * @returns {Number[]} - [east, south] distance in metres from the image's north-west corner to the game's
 */
export function gridOffset(minimap) {
    if (!minimap.game) return [0, 0];
    const imageMin = [Math.min(minimap.corner0[0], minimap.corner1[0]), Math.min(minimap.corner0[1], minimap.corner1[1])];
    return [minimap.game.min[0] - imageMin[0], minimap.game.min[1] - imageMin[1]];
}


/**
 * Same as gridOffset for one gameplay layer: a layer can ship its own, smaller minimap (Skirmish, Seed) or corners a
 * metre off the map's, and the game starts that layer's grid at its own corner.
 * @param {{corner0: Number[], corner1: Number[]}} minimap - SDK_data.minimap, for the image extent
 * @param {Array<{location_x: number, location_y: number}>} mapTextureCorners - the layer's two corners, in cm
 * @returns {Number[]} - [east, south] distance in metres from the image's north-west corner to the layer's
 */
export function layerGridOffset(minimap, mapTextureCorners) {
    const imageMin = [Math.min(minimap.corner0[0], minimap.corner1[0]), Math.min(minimap.corner0[1], minimap.corner1[1])];
    const [first, second] = mapTextureCorners;
    return [
        Math.min(first.location_x, second.location_x) / 100 - imageMin[0],
        Math.min(first.location_y, second.location_y) / 100 - imageMin[1],
    ];
}

/**
 * Size of the game's grid: the game's minimap, from its corners (`game`), else the image's. Outside it the game
 * draws no line and gives no keypad.
 * @param {{corner0: Number[], corner1: Number[], game?: {min: Number[], max: Number[]}}} minimap - SDK_data.minimap
 * @returns {Number[]} - [width, height] in metres
 */
export function gridSize(minimap) {
    const [first, second] = minimap.game ? [minimap.game.min, minimap.game.max] : [minimap.corner0, minimap.corner1];
    return [Math.abs(second[0] - first[0]), Math.abs(second[1] - first[1])];
}

/**
 * Same as gridSize for one gameplay layer, from its own corners
 * @param {Array<{location_x: number, location_y: number}>} mapTextureCorners - the layer's two corners, in cm
 * @returns {Number[]} - [width, height] in metres
 */
export function layerGridSize(mapTextureCorners) {
    const [first, second] = mapTextureCorners;
    return [Math.abs(second.location_x - first.location_x) / 100, Math.abs(second.location_y - first.location_y) / 100];
}

/**
 * How far from a FOB the next one has to be placed: the radius of the loaded layer, else the one of the map's
 * regular layers.
 * @param {{radiusExclusion: number}} map - entry of MAPS
 * @param {string} [layerName] - raw name of the loaded layer, for example "AlBasrah_RAAS_v3"
 * @returns {number} - metres
 */
export function fobExclusionRadius(map, layerName) {
    return SMALL_FOB_LAYERS.has(layerName) ? FOBEXCLUSIONS.small : map.radiusExclusion;
}

// Compute size in meters and z-scaling from SDK data for each map
export function initMapsProperties() {
    MAPS.forEach((map) => {
        map.size = bounds(map.SDK_data.minimap.corner0, map.SDK_data.minimap.corner1)[0];
        map.sizeY = bounds(map.SDK_data.minimap.corner0, map.SDK_data.minimap.corner1)[1];
        map.gridOffset = gridOffset(map.SDK_data.minimap);
        map.gridSize = gridSize(map.SDK_data.minimap);
        map.scaling = scale(
            map.SDK_data?.heightmap?.BWlevels?.[0] ?? 0,
            map.SDK_data?.heightmap?.BWlevels?.[1] ?? 0,
            map.SDK_data?.heightmap?.scale?.[2] ?? 1
        ) || 1;
    });
}

