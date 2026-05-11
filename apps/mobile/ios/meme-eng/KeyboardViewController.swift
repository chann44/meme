import UIKit
import SwiftUI

class KeyboardViewController: UIInputViewController {

    private let nextKeyboardButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()

        setupKeyboardView()
        setupNextKeyboardButton()
    }

    private func setupKeyboardView() {

        let keyboardView = KeyboardView(
            onInsertText: { [weak self] text in
                self?.textDocumentProxy.insertText(text)
            },
            onDelete: { [weak self] in
                self?.textDocumentProxy.deleteBackward()
            }
        )

        let hostingController = UIHostingController(
            rootView: keyboardView
        )

        addChild(hostingController)

        hostingController.view.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(hostingController.view)

        NSLayoutConstraint.activate([
            hostingController.view.topAnchor.constraint(equalTo: view.topAnchor),
            hostingController.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hostingController.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            hostingController.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])

        hostingController.didMove(toParent: self)
    }

    private func setupNextKeyboardButton() {

        nextKeyboardButton.translatesAutoresizingMaskIntoConstraints = false

        nextKeyboardButton.setTitle("🌐", for: .normal)

        nextKeyboardButton.addTarget(
            self,
            action: #selector(handleInputModeList(from:with:)),
            for: .allTouchEvents
        )

        view.addSubview(nextKeyboardButton)

        NSLayoutConstraint.activate([
            nextKeyboardButton.leadingAnchor.constraint(
                equalTo: view.leadingAnchor,
                constant: 12
            ),

            nextKeyboardButton.bottomAnchor.constraint(
                equalTo: view.bottomAnchor,
                constant: -8
            )
        ])
    }
}
