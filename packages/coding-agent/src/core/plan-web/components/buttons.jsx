import React from "react";

export function IconButton({ active = false, disabled = false, label, onClick, children }) {
	return (
		<button
			type="button"
			className={`icon-button${active ? " active" : ""}`}
			aria-label={label}
			disabled={disabled}
			title={label}
			onClick={onClick}
		>
			{children}
		</button>
	);
}

export function ActionButton({ className = "", disabled, icon: Icon, label, onClick }) {
	return (
		<button type="button" className={`button ${className}`} disabled={disabled} onClick={onClick}>
			<Icon aria-hidden="true" />
			<span>{label}</span>
		</button>
	);
}
