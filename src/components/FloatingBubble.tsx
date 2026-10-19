interface Props {
  onOpen: () => void;
}

export default function FloatingBubble({ onOpen }: Props) {
  // A buborék középre igazítva ül a (nagyobb) átlátszó ablakban, hogy a lágy
  // árnyék körben ki tudjon futni, és ne vágódjon négyzetesre az ablak szélén.
  return (
    <div className="flex h-full w-full items-center justify-center">
      <button
        onClick={onOpen}
        title="Vellum"
        className="bubble-pulse flex h-[68px] w-[68px] items-center justify-center rounded-full
                   transition-transform duration-150 hover:scale-105 active:scale-95"
      >
        <img
          src="./vellum_logo.png"
          alt="Vellum"
          className="h-11 w-11 object-contain"
          draggable={false}
        />
      </button>
    </div>
  );
}
