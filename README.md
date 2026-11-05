
<h1 align="center">
    <a href="https://squadcalc.app">
      <img src="./public/img/github/logo.webp" alt="squadcalc logo">
    </a>
</h1>

<div align="center">
    <a href="https://discord.gg/BNPAc5kEJP">  
      <img src="https://img.shields.io/badge/Discord-111?style=for-the-badge&logo=discord&logoColor=white" alt="discord"></a>
    <a href="https://github.com/sh4rkman/SquadCalc/blob/master/CHANGELOG.md">  
      <img src="https://img.shields.io/badge/CHANGELOG-111?style=for-the-badge&logo=github&logoColor=white" alt="changelog"></a>
    <a href="https://github.com/sh4rkman/SquadCalc/wiki/Translating-SquadCalc">  
      <img src="https://img.shields.io/badge/TRANSLATE-111?style=for-the-badge&logo=google-translate&logoColor=white" alt="translate"></a>
    <a href="https://github.com/sh4rkman/SquadCalc/wiki">  
      <img src="https://img.shields.io/badge/WIKI-111?style=for-the-badge&logo=github&logoColor=white" alt="wiki"></a>  
</div>


</br>
</br>

[SquadCalc.app](https://squadcalc.app/) – The Ultimate In-Game Companion for [Squad](https://joinsquad.com/)!


</br>
</br>
 
# <b>Screenshots</b>

<div align="center">
    <picture><img src="./public/img/github/desktop_ui_1.webp" alt="classic preview"></picture>  
    <picture><img src="./public/img/github/desktop_ui_5.webp" alt="Lane Finder preview"></picture>
    <picture><img src="./public/img/github/desktop_ui_6.webp" alt="capzone/mains preview"></picture>
    <picture><img src="./public/img/github/desktop_ui_2.webp" alt="topographic preview"></picture>
    <!-- <picture><img src="./public/img/github/desktop_ui_3.webp" alt="weapon information preview"></picture>
    <picture><img src="./public/img/github/desktop_ui_4.webp" alt="calculations information preview"></picture> -->
    <!-- <picture><img src="./public/img/github/desktop_ui_0.webp" alt="legacy preview"></picture> -->
</div>

</br>

# <b>Features</b>


## Mortar Calculator

<details>
  <summary><b>Elevations Calculations</b></summary>
  </br>
  SquadCalc utilizes heightmaps extracted from the Squad SDK to precisely compute the elevation difference between mortars and targets, automatically adjusting the elevation settings.  
  
  </br>

  [Check out the Wiki](https://github.com/sh4rkman/SquadCalc/wiki/Deducing-Altitude) to understand how it works.

  </br>
</details>

<details>
  <summary><b>Object volumes in the line of fire</b></summary>
  </br>
  The heightmap holds one height per cell, so a doorway or an open window looks like solid wall, and trees are missing.
  With <i>Object volumes in the line of fire</i> turned on in the settings (off by default), the obstacle check of a direct-fire weapon and the fire coverage test the shell against the voxel columns of the buildings, walls, bridges and trees instead: a shot passes through an open window or doorway (a door is either open or absent, so a doorway is always a hole), and is stopped by a closed window, a wall or a tree. No penetration is computed.
  The volume files (about 0.1 to 15 MB per map plus 1 to 6 MB of landscape heights) and the 0.4 MB WebAssembly engine are downloaded only when the setting is on and the map has them; otherwise, and when anything fails to load, the heightmap is used as before. Details and accuracy: <a href="./engine/README.md">engine/README.md</a>.

  </br>
</details>

<details>
  <summary><b>Firing positions and the damage zone with cover</b></summary>
  </br>
  With <i>Object volumes in the line of fire</i> on, a map that has volume files and a direct-fire weapon (one with a sight and a spread) selected, the target dialog has a <i>Firing positions</i> button. It draws on the map the ground positions, up to the weapon's range (at most 2000 m), from where a shooter has a clear line of fire to the target at the height chosen for it (a floor, a window, a roof, or the ground). Green is a close position with room around the line, amber a far one or one where the line passes close to an obstacle, faint red a blocked one. The score counts the distance (a far position stays viable) and the clearance of the line of fire around obstacles, as wide as the weapon's spread. The line is the weapon's low trajectory from the muzzle; open windows and doorways let it through, closed windows and walls stop it, and no penetration is computed. It is off by default, loaded only when the button is pressed, and computed in the background.
  </br></br>
  The voxel walk errs on the side of blocking. Where the target lies at least 50 m inside the square of a <i>precision region</i> (the exact collision triangles of 150 m around a target, 0.1 to 5 MB, published for a few targets only, currently one on Jensen) the legend says <i>Exact triangles within N m of the target, voxels beyond</i> and the lines of fire that pass close to geometry within that square are decided by the exact triangles; otherwise it says <i>Voxels only</i>. Measured against the exact triangle tracer on a target in a Jensen building: no false clear and no false blocked position with the region, 1 and 275 (2 and 1 337 at another height) of 31 560 without it. Details, timings per map and the method: <a href="./engine/README.md">engine/README.md</a>.
  </br></br>
  The damage zone drawn around a target (the red, orange and blue circles of the explosion) uses the voxels as cover when the same setting is on: a soldier behind a wall is covered, one in line with an open doorway or window is not, and the round lands at the height chosen for the target.

  </br>
</details>

<details>
  <summary><b>Target heights and structure damage</b></summary>
  </br>
  With <i>Object volumes in the line of fire</i> on and a map that has volume files, clicking a target opens its dialog with a <i>Target height</i> list: the floors, ceilings, roof, windows and doorways found by a vertical ray through the voxel column at the target (open windows and doorways are holes, closed windows are solid, a door is open or absent; they are recognised from the shape of the walls). The chosen height is used for the elevation, the height difference and the line-of-fire check, and shows in the target's popup. <i>Ground</i>, the default, is the heightmap's height as before.
  </br></br>
  Clicking a deployable marker (FOB radio, HAB, mortar, HMG, GMG, AA gun, ammo crate, repair station) shows how many shells of the selected ammunition destroy it from full health; the target dialog shows the same for a target within 5 m of such a marker. Health, damage-type multipliers and the way the game applies them to a structure (minimum damage, direct hit against near miss, distance from the burst) are the game's, read from the server code; the impact of a direct hit and the mortars' secondary explosion are inferred. Nothing is measured in game. Armour-piercing and machine-gun rounds do no structure damage. Method and data: <code>tools/volumetric/docs/structure-damage.md</code> of the deployment repository.

  </br>
</details>

<details>
  <summary><b>Spread and Damages radiuses</b></summary>  
  </br>
  Reduce teamkilling and maximize your damage by visualizing the spread of your shells and the range of their explosions.  

  Check out the Wiki on [Spread](https://github.com/sh4rkman/SquadCalc/wiki/Deducing-Spread) and [Damage](https://github.com/sh4rkman/SquadCalc/wiki/Deducing-Damage-Radius) to understand how it works.

  <div align="center">
    <img width="50%" src="./public/img/github/radiuses.webp" alt="settings">
  </div>
  </br>
</details>

<details>
  <summary><b>Commonly used spot</b></summary>
  </br>
  Squadcalc is logging up to 15000 weapon positions for each map and each weapons, thus allowing to create a dynamic heatmap of where other players commonly set their weapons. If you're having trouble finding a good spot to place your mortar or weapons, activate the 'Frequent Locations' feature !  

  </br>
  <div align="center">
    <img width="60%" src="./public/img/github/heatmap.webp" alt="commonly used spots">
  </div>
  </br>
</details>


<details>
  <summary><b>Squad Mortar Overlay Compatibility</b></summary>

  </br>  

  SquadCalc is compatible with [Squad Mortar Overlay](https://github.com/Devil4ngle/SquadMortarOverlay), made by [Devil4ngle](https://github.com/Devil4ngle).  
  Squad Mortar Overlay is a program capturing screenshots from your ingame map and overlaying it with SquadCalc.  

  It allows :
  * Having ingame markers automatically merged into SquadCalc map to quickly place the right targets
  * Having an ingame overlay with the current SquadCalc calculations displayed in front of Squad


  </br>

  ### <div align="center">[> Download Squad Mortar Overlay <](https://github.com/Devil4ngle/SquadMortarOverlay/releases)</div>

</details>

</br>

## Layer Info




<details>
  <summary><b>Lanes/Flags preview</b></summary>
  </br>

  Hover over a flag to preview how selecting it would affect the layer.  
  This allows you to quickly scan how the layer looks at the start of the game, for example.

  <div align="center">
    <picture><img width="70%" src="./public/img/github/layer-finder.gif" alt="capzones"></picture>
  </div></br>

</details>

<details>
  <summary><b>Capzones</b></summary>
  </br>

  SquadCalc lets you see each precise flag capzone extracted from the game SDK and view it in detail.  
  It helps you find the perfect location for a FOB, the best route to sneak into a cap zone, or even where to fire mortars effectively.

  <div align="center">
    <picture><img width="80%" src="./public/img/github/capzones.webp" alt="capzones"></picture>
  </div></br>

</details>



<details>
  <summary><b>Main Protection & No-deploy zone</b></summary>
  </br>

  Plan your radios and mortars : squadcalc display every mains protection zones (no vehicles shooting) and no-deploy (radios, mortars, emplacement).

  <div align="center">
    <picture><img width="70%" src="./public/img/github/mains.webp" alt="capzones"></picture>
  </div></br>

</details>



<details>
  <summary><b>Real map borders</b></summary>
  </br>  

  Each layer can have have it's own playable aera : squadcalc shows the exact invisible map limits.  

  <div align="center">
    <picture><img width="70%" src="./public/img/github/borders.webp" alt="autocomplete"></picture>
  </div></br>
</details>




<details>
  <summary><b>Autocomplete</b></summary>
  </br>  

  SquadCalc will automatically complete the layer if there is only one possible incoming flag, saving you a few clicks.

</details>





<details>
  <summary><b>Factions, Units and Vehicles list</b></summary>
  </br>  

  Browse every layer available factions, units, and vehicles :

  <div align="center">
    <picture><img width="70%" src="./public/img/github/units.webp" alt="autocomplete"></picture>
  </div><br>



  You can also pin the enemy vehicles list to your map and set timers when you destroy them : you will receive a sound notification when they respawn !

  <div align="center">
    <picture><img width="70%" src="./public/img/github/timer.webp" alt="autocomplete"></picture>
  </div></br>

  Change faction and pick a unit directly from the map by rightclicking a main :

  <div align="center">
    <picture><img width="40%" src="./public/img/github/mainCtxMenu.webp" alt="autocomplete"></picture>
  </div></br>

</details>

<details>
  <summary><b>Vehicles Spawns Locations</b></summary>
  </br>  

  Anticipate where the vehicles will be spawning :

  <div align="center">
    <picture><img width="100%" src="./public/img/github/spawns.gif" alt="autocomplete"></picture>
  </div><br>
</details>

</br>


## Others


<details>
  <summary><b>Shared Sessions</b></summary>
  </br>

  Start a shared session and invite your friends!  

  Collaborate on a single map, sharing markers, weapons, and targets in real time.
  Synchronize your mortar targets more efficiently, strategize together, and develop tactics seamlessly.

  Sessions works up to 10 participants.

  <div align="center">
    <picture><img width="100%" src="./public/img/github/sessions.webp" alt="map layers"></picture>
  </div>
  
</details>




<details>
  <summary><b>Advanced Customisation & Informations</b></summary>
  </br>

  Want to see Spread radius, time of flight, distance AND bearing for each targets ? You can.  
  Rather have a minimalist/non-clustered map ? you can too. Hop in settings to customise everything.

  Get a better and complete understanding of your shots and visualise a simulation of the projectile path and the terrain between you and your targets. You can even see if terrain is going to block your projectiles when using low angle weapons ! (UB/GRAD) 

  <div align="center">
    <picture>
        <img width="60%" src="./public/img/github/settings.webp" alt="settings">
    </picture>
      <picture>
      <img width="46%" src="./public/img/github/simulation.webp" alt="target information">
    </picture>
    <picture>
      <img width="40%" src="./public/img/github/weaponInformation.webp" alt="weapon information">
    </picture>
  </div>
</details>



<details>
  <summary><b>Map Layers</b></summary>
  </br>

  <div align="center">
    <picture><img width="50%" src="./public/img/github/layers.webp" alt="map layers"></picture>
  </div>

  ### Base map :
  The classic, straight from the game base map.  

  ### Terrain map :
  Base map enhanced with bumpmap from SDK's heightmap. Add a better comprehension of terrain.  
  Also known as "why the fuck is it not the default ingame map?"

  ### Topographic map :
  A mix of bump map, contour map with a touch of hypsometric colors for a complete understanding of map reliefs.

</details>



<details>
  <summary><b>Ultra HD Maps</b></summary>
  </br>

  <div align="center">
    <picture><img width="80%" src="./public/img/github/hdmaps.webp" alt="map layers"></picture>
    <div align="center">UHD Maps vs regular ingame map image</div>
  </div>


  <br>

  With a single click, you can switch the map to a high-definition version powered by AI upscaling. The HD maps are 8192×8192 resolution images, letting you explore every part of the map in ultra-sharp detail right within the Leaflet interface.

</details>

<details>
  <summary><b>Server Syncing</b></summary>
  </br>

  <br>

  <div align="center">
    <picture><img width="80%" src="./public/img/github/servers.webp" alt="Server Syncing"></picture>
  </div>

  <br>

  Browse the active servers and click the one you're playing on. SquadCalc will automatically update and load the factions and units for the server’s current map. It will even update automatically if it detects a map change!

</details>

<details>
  <summary><b>Import/Export Your Maps</b></summary>
  </br>

  <br>

  <div align="center">
    <picture><img width="50%" src="./public/img/github/import_export.webp" alt="Map Import/Export Preview"></picture>
  </div>

  <br>

  Easily export your map and markers to an offline file for backup or sharing. To restore them later, just drag and drop the file into SquadCalc—your markers will be instantly loaded. These files are also perfect for sharing with teammates to ensure everyone’s on the same page.

</details>

</br></br></br>
# **Attributions**
</br>

🗺️ Map System built on **[Leaflet JS](https://leafletjs.com/)**  
🖼️ Map Images, Marker Icons are from SquadSDK by **[OffWorld Industries](https://www.offworldindustries.com/)**  
🧮 Layers & Factions Data are extracted thanks to **[Squad-Wiki Pipeline Map Data](https://github.com/Squad-Wiki/squad-wiki-pipeline-map-data)** SDK extractor tools *(Special thanks to [Shanomac99](https://github.com/Shanomac99))*  
🖥️ Servers data provided by **[BattleMetrics](https://www.battlemetrics.com)**  
🗣️ AI Text-To-Speech made with **[Luvvoice](https://luvvoice.com/)**  
🔣 Icons by **[FontAwesome](https://fontawesome.com/icons)**  
⛰️ heightmaps extracted with **[SquadHeight](https://github.com/Metroseksuaali/SquadHeight)** by [Metroseksuaali](https://github.com/Metroseksuaali)  
👌🏼 Thanks to everyone supporting the project with kinds words, clever suggestions, and better code than mine


</br></br></br>
# **Contributors**
</br>

* [Antiaris74](https://github.com/Antiaris74)  
* [d503-ai](https://github.com/d503-ai)  
* [Devil4ngle](https://github.com/Devil4ngle)
* [f0xcb](https://github.com/f0xcb) 
* [Ferrariic](https://github.com/Ferrariic)
* [Guducat](https://github.com/Guducat)
* [Hans-Vader](https://github.com/Hans-Vader) 
* [Metroseksuaali](https://github.com/Metroseksuaali)  
* [TheMatheusDev](https://github.com/TheMatheusDev)  
* [SphaeroX](https://github.com/SphaeroX)  
* sitroz
* [yobaNGE](https://github.com/yobaNGE)  



</br></br></br>
# **Support the project**
</br>

[![buy me a coffee](https://img.shields.io/badge/BUY%20ME%20A%20COFFEE-b12222?style=for-the-badge&logo=buy-me-a-coffee&logoColor=white)](https://buymeacoffee.com/sharkman)  
[![help to translate](https://img.shields.io/badge/HELP%20TO%20TRANSLATE-111?style=for-the-badge&logo=google-translate&logoColor=white)](https://github.com/sh4rkman/SquadCalc/wiki/Translating-SquadCalc)


